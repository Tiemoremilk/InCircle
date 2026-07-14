const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");
const {
  DEFAULT_CUSTOM_THEME_RGBA,
  DEFAULT_THEME_KEY,
  PRESET_THEME_KEYS,
  THEME_KEYS,
  legacyThemeKey,
  normalizeCustomThemeRgba,
  normalizeThemeKey,
} = require("../src/theme");
const miniTheme = require("../../inCircleClient/utils/theme");

const root = path.resolve(__dirname, "../..");

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function whiteContrast(hex) {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

function rgbDistance(first, second) {
  const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const left = rgb(first);
  const right = rgb(second);
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

test("eleven presets plus one custom theme stay distinct and accessible", () => {
  const themes = miniTheme.THEMES;
  assert.deepEqual(
    themes.map((theme) => theme.key),
    PRESET_THEME_KEYS
  );
  assert.equal(themes.length, 11);
  assert.deepEqual(THEME_KEYS, PRESET_THEME_KEYS.concat(["custom"]));
  const pickerOptions = miniTheme.getThemeOptions("custom", { includeCustom: true });
  assert.equal(pickerOptions.length, 12);
  assert.equal(pickerOptions[pickerOptions.length - 1].key, "custom");
  assert.equal(pickerOptions.some((theme) => theme.key === "iris"), false);
  assert.equal(new Set(themes.map((theme) => theme.name)).size, themes.length);
  assert.equal(new Set(themes.map((theme) => theme.primary)).size, themes.length);
  themes.forEach((theme) => {
    assert.match(theme.primary, /^#[0-9a-f]{6}$/i);
    assert.ok(whiteContrast(theme.primary) >= 4.5, `${theme.key} primary must support white button text`);
  });
  for (let left = 0; left < themes.length; left += 1) {
    for (let right = left + 1; right < themes.length; right += 1) {
      assert.ok(
        rgbDistance(themes[left].primary, themes[right].primary) >= 28,
        `${themes[left].key} and ${themes[right].key} are too visually similar`
      );
    }
  }
});

test("Mini Program palette metadata and WXSS variables stay synchronized", () => {
  const styles = fs.readFileSync(path.join(root, "inCircleClient/app.wxss"), "utf8").toLowerCase();
  miniTheme.THEMES.forEach((theme) => {
    const match = styles.match(new RegExp(`\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(match, `missing WXSS block for ${theme.key}`);
    const block = match[1];
    assert.ok(block.includes(`--theme-primary: ${theme.primary.toLowerCase()}`));
    assert.ok(block.includes(`--theme-primary-dark: ${theme.primaryDark.toLowerCase()}`));
    assert.ok(block.includes(`--theme-accent: ${theme.accent.toLowerCase()}`));
    assert.ok(block.includes(theme.pageBg.toLowerCase()));
  });
});

test("custom tabbar selected icons stay synchronized with all preset themes", () => {
  const appStyles = fs.readFileSync(path.join(root, "inCircleClient/app.wxss"), "utf8").toLowerCase();
  const tabbarStyles = fs.readFileSync(path.join(root, "inCircleClient/custom-tab-bar/index.wxss"), "utf8").toLowerCase();
  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const variable = (block, name) => {
    const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
    return match ? compact(match[1]) : "";
  };

  miniTheme.THEMES.forEach((theme) => {
    const appMatch = appStyles.match(new RegExp(`\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`));
    const tabbarMatch = tabbarStyles.match(
      new RegExp(`\\.custom-tabbar\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`)
    );
    assert.ok(appMatch, `missing app theme block for ${theme.key}`);
    assert.ok(tabbarMatch, `missing tabbar theme block for ${theme.key}`);
    assert.equal(variable(tabbarMatch[1], "tabbar-active"), theme.primary.toLowerCase());
    assert.equal(
      variable(tabbarMatch[1], "tabbar-active-filter"),
      variable(appMatch[1], "theme-icon-filter"),
      `${theme.key} tabbar icon filter is stale`
    );
    assert.ok(variable(tabbarMatch[1], "tabbar-shadow"), `${theme.key} tabbar shadow is missing`);
  });

  assert.match(tabbarStyles, /\.custom-tabbar \.tabbar-item\.active \.tabbar-icon\s*\{[^}]*var\(--tabbar-active-filter/s);
});

test("legacy and invalid theme preferences normalize safely", () => {
  assert.equal(DEFAULT_THEME_KEY, "forest");
  assert.equal(normalizeThemeKey("theme-sky"), "sky");
  assert.equal(normalizeThemeKey("unknown"), "forest");
  assert.equal(normalizeThemeKey("unknown", ""), "");
  assert.equal(normalizeThemeKey("custom"), "custom");
  assert.equal(normalizeThemeKey("iris"), "forest");
  assert.equal(legacyThemeKey({ themeIndex: 6 }, ""), "cyan");
  assert.equal(legacyThemeKey({ theme_index: 11 }, ""), "lilac");
  assert.deepEqual(normalizeCustomThemeRgba({ r: 12, g: 34, b: 56, a: 0.42 }), { r: 12, g: 34, b: 56, a: 0.42 });
  assert.equal(normalizeCustomThemeRgba({ r: 999, g: 0, b: 0, a: 1 }, null), null);
});

test("theme preference adopts once, then explicit updates persist a validated key", async () => {
  const queries = [];
  const service = Object.create(InCircleService.prototype);
  service.db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [{
          id: params[0],
          theme_key: params[1],
          custom_theme_rgba: params[2] ? JSON.parse(params[2]) : DEFAULT_CUSTOM_THEME_RGBA,
        }],
      };
    },
  };
  service.requireUser = async () => ({ user: { id: "user-1" } });

  const existing = { id: "user-1", theme_key: "berry" };
  assert.equal(await service.syncClientThemePreference(existing, { clientThemeKey: "sky" }), existing);
  assert.equal(queries.length, 0);

  const adopted = await service.syncClientThemePreference(
    { id: "user-1", theme_key: null },
    { clientThemeKey: "mint" }
  );
  assert.equal(adopted.theme_key, "mint");
  assert.equal(queries.length, 1);

  const explicit = await service.syncClientThemePreference(existing, {
    clientThemeKey: "sky",
    themePreferenceExplicit: true,
  });
  assert.equal(explicit.theme_key, "sky");
  assert.deepEqual(queries[1].params, ["user-1", "sky", true]);

  const updated = await service.updateTheme({ themeKey: "lilac" });
  assert.deepEqual(updated, { themeKey: "lilac", customTheme: DEFAULT_CUSTOM_THEME_RGBA });
  assert.deepEqual(queries[2].params, ["user-1", "lilac", JSON.stringify(DEFAULT_CUSTOM_THEME_RGBA)]);

  const rgba = { r: 18, g: 96, b: 173, a: 0.65 };
  const custom = await service.updateTheme({ themeKey: "custom", customTheme: rgba });
  assert.deepEqual(custom, { themeKey: "custom", customTheme: rgba });
  assert.deepEqual(queries[3].params, ["user-1", "custom", JSON.stringify(rgba)]);

  await assert.rejects(
    () => service.updateTheme({ themeKey: "not-a-theme" }),
    (error) => error && error.errCode === "INVALID_THEME"
  );
  await assert.rejects(
    () => service.updateTheme({ themeKey: "custom", customTheme: { r: -1, g: 2, b: 3, a: 1 } }),
    (error) => error && error.errCode === "INVALID_CUSTOM_THEME"
  );
});

test("theme preference is wired through schema, migration, API and authenticated route", () => {
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0019_custom_theme_rgba.sql"),
    "utf8"
  );
  const api = fs.readFileSync(path.join(root, "inCircleClient/utils/api.js"), "utf8");
  const route = fs.readFileSync(path.join(root, "server/src/routes/incircle.js"), "utf8");

  assert.match(schema, /theme_key text DEFAULT 'forest'/);
  assert.match(schema, /custom_theme_rgba jsonb/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS custom_theme_rgba jsonb/);
  assert.match(migration, /UPDATE incircle_users SET theme_key = 'forest' WHERE theme_key = 'iris'/);
  assert.match(api, /requestAction\("incircleUpdateTheme", Object\.assign/);
  assert.match(route, /case "incircleUpdateTheme":\s*return service\.updateTheme\(body\)/);
});

test("custom theme derives global variables and every page receives them", () => {
  const custom = miniTheme.buildCustomTheme({ r: 220, g: 180, b: 35, a: 0.4 });
  assert.equal(custom.key, "custom");
  assert.match(custom.className, /theme-custom/);
  assert.match(custom.pageStyle, /--theme-primary:/);
  assert.match(custom.pageStyle, /--theme-icon-filter:/);
  assert.match(custom.tabBarVariables, /--tabbar-active:/);
  assert.equal(custom.swatch, "rgba(220, 180, 35, 0.4)");

  const app = JSON.parse(fs.readFileSync(path.join(root, "inCircleClient/app.json"), "utf8"));
  app.pages.forEach((page) => {
    const template = fs.readFileSync(path.join(root, "inCircleClient", `${page}.wxml`), "utf8");
    assert.match(template, /<page-meta page-style="\{\{themeStyle\}\}/, page);
  });
});

test("circle switch offers a live RGBA picker and truncates long circle descriptions", () => {
  const script = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.js"), "utf8");
  const template = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.wxss"), "utf8");

  assert.match(template, /custom-theme-mask/);
  ["r", "g", "b", "a"].forEach((channel) => {
    assert.match(template, new RegExp(`data-channel="${channel}"`));
  });
  assert.match(template, /bindchanging="onCustomThemeChannelChange"/);
  assert.match(script, /updateTheme\(theme\.CUSTOM_THEME_KEY, rgba\)/);
  assert.match(script, /themeOptions\[\$\{customIndex\}\]\.swatch/);
  assert.match(styles, /\.recent-circle-row \.circle-copy\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
});

test("custom RGBA selection persists locally and applies to a live page", () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const app = { globalData: {} };
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    setNavigationBarColor() {},
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];

  try {
    const rgba = { r: 28, g: 104, b: 188, a: 0.72 };
    const selected = miniTheme.setTheme("custom", rgba);
    assert.equal(selected.key, "custom");
    assert.deepEqual(app.globalData.customTheme, rgba);

    const page = {
      data: { allowCustomThemeOption: true },
      setData(next) { Object.assign(this.data, next); },
    };
    miniTheme.applyPageTheme(page);
    assert.equal(page.data.themeKey, "custom");
    assert.match(page.data.themeClass, /theme-custom/);
    assert.match(page.data.themeStyle, /--theme-primary:/);
    assert.equal(page.data.themeOptions.length, 12);
    assert.equal(page.data.themeOptions[11].activeClass, "active");
    assert.match(miniTheme.getTabBarStyle(), /--tabbar-active:/);
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages;
    else global.getCurrentPages = previousGetCurrentPages;
  }
});
