const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const theme = require("../../inCircleClient/utils/theme");

const ROOT = path.resolve(__dirname, "../..");
const WHITE = [255, 255, 255];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function cssBlock(styles, selector) {
  const matches = [...styles.matchAll(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "g"))];
  assert.ok(matches.length, `missing selector ${selector}`);
  return matches[matches.length - 1][1];
}

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(color) {
  const channels = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

test("login map actions use one high-contrast theme pair without layout changes", () => {
  [
    ["inCircleClient/pages/account-settings/index.wxss", ".session-location-action"],
    ["inCircleClient/pages/login-records/index.wxss", ".record-location-action"],
  ].forEach(([relativePath, selector]) => {
    const styles = read(relativePath);
    const action = cssBlock(styles, selector);
    const icon = cssBlock(styles, `${selector} image`);
    assert.match(action, /border:\s*1rpx solid var\(--theme-primary-dark, #1c5638\)/);
    assert.match(action, /background:\s*var\(--theme-primary-dark, #1c5638\)/);
    assert.match(action, /color:\s*#ffffff/);
    assert.match(icon, /filter:\s*brightness\(0\) invert\(1\)/);
  });
});

test("activity detail map action reuses the hero-pill contrast treatment", () => {
  const template = read("inCircleClient/pages/activity-detail/index.wxml");
  const styles = read("inCircleClient/pages/activity-detail/index.wxss");
  const action = cssBlock(styles, ".location-action");
  const label = cssBlock(styles, ".location-action > text");

  assert.match(template, /class="location-action hero-pill"/);
  assert.match(
    styles,
    /\.detail-hero \.location-action\.hero-pill\s*\{[\s\S]*background:\s*rgba\(255, 255, 255, 0\.17\)/
  );
  assert.match(action, /border:\s*1rpx solid rgba\(255, 255, 255, 0\.5\)/);
  assert.match(action, /background:\s*rgba\(255, 255, 255, 0\.17\)/);
  assert.match(action, /color:\s*#ffffff/);
  assert.match(action, /text-shadow:/);
  assert.match(label, /color:\s*#ffffff/);
});

test("preset and custom theme map-action colors meet contrast thresholds", () => {
  const customThemes = [];
  const channelSamples = [0, 1, 16, 32, 64, 96, 128, 160, 192, 224, 254, 255];
  const alphaSamples = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];

  channelSamples.forEach((red) => {
    channelSamples.forEach((green) => {
      channelSamples.forEach((blue) => {
        alphaSamples.forEach((alpha) => {
          customThemes.push(theme.buildCustomTheme({ r: red, g: green, b: blue, a: alpha }));
        });
      });
    });
  });

  [...theme.THEMES, ...customThemes].forEach((entry, index) => {
    const ratio = contrast(rgb(entry.primaryDark), WHITE);
    const identity = entry.key === theme.CUSTOM_THEME_KEY
      ? `custom theme sample ${index - theme.THEMES.length + 1}`
      : entry.key;
    assert.ok(ratio >= 4.5, `${identity} map action contrast is ${ratio.toFixed(2)}:1`);
  });
});
