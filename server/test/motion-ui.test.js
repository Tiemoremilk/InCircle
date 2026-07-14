const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const miniProgramRoot = path.resolve(__dirname, "../../inCircleClient");

function read(relativePath) {
  return fs.readFileSync(path.join(miniProgramRoot, relativePath), "utf8");
}

test("global motion keeps explicit feedback while page entry remains static", () => {
  const styles = read("app.wxss");

  assert.match(styles, /--motion-press-duration:\s*140ms/);
  assert.match(styles, /--motion-state-duration:\s*200ms/);
  assert.doesNotMatch(styles, /\.page\s*\{[^}]*animation\s*:/s);
  assert.doesNotMatch(styles, /\.motion-hero\s*\{[^}]*animation\s*:/s);
  assert.doesNotMatch(styles, /\.motion-section\s*\{[^}]*animation\s*:/s);
  assert.doesNotMatch(styles, /\.motion-content-swap\s*\{[^}]*animation\s*:/s);
  assert.doesNotMatch(styles, /\.motion-list-item\s*\{[^}]*animation\s*:/s);
  assert.doesNotMatch(styles, /\.motion-message\s*\{[^}]*animation\s*:/s);
  assert.match(styles, /\.loading-panel\s*\{[^}]*animation:\s*incircleLoadingReveal\s+160ms[^}]*140ms/s);
  assert.match(styles, /\.motion-progress\s*\{[^}]*transform-origin:\s*left center/s);
});

test("AI streaming updates reuse stable message nodes without entry animation", () => {
  const template = read("pages/ai-chat/index.wxml");
  const styles = read("app.wxss");

  assert.match(template, /class="message-row[^\n]*motion-message/);
  assert.match(template, /wx:for="\{\{messages\}\}" wx:key="id"/);
  assert.match(template, /index >= messages\.length - 6/);
  assert.doesNotMatch(styles, /\.motion-message\s*\{[^}]*animation\s*:/s);
});

test("shared animated components honor reduced motion", () => {
  const emptyState = read("components/empty-state/index.wxss");
  const tabBar = read("custom-tab-bar/index.wxss");
  const fab = read("components/ai-fab/index.wxss");

  assert.match(emptyState, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.empty-art/);
  assert.match(tabBar, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.tabbar-icon/);
  assert.match(tabBar, /\.tabbar-item\.active \.tabbar-icon\s*\{[^}]*transform:\s*scale\(1\.06\)/s);
  assert.doesNotMatch(`${tabBar}\n${fab}`, /transition:[^;]*(?:filter|box-shadow|backdrop-filter)/);
});
