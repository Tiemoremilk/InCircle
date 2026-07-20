const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const pageJs = read("inCircleClient/pages/admin-user-detail/index.js");
const pageWxml = read("inCircleClient/pages/admin-user-detail/index.wxml");
const pageWxss = read("inCircleClient/pages/admin-user-detail/index.wxss");

test("management user detail omits unavailable WeChat profile fields", () => {
  assert.doesNotMatch(pageWxml, />微信名<|>微信账号</);
  assert.doesNotMatch(pageJs, /wechatNameText|wechatAccountText|WECHAT_ACCOUNT_UNAVAILABLE_TEXT/);
  assert.match(pageWxml, />OpenID<\/text>/);
  assert.match(pageWxml, />UnionID<\/text>/);
});

test("management user detail presents preset and custom themes from server data", () => {
  assert.match(pageJs, /require\("\.\.\/\.\.\/utils\/theme"\)/);
  assert.match(pageJs, /user\s*&&\s*user\.themeKey/);
  assert.match(pageJs, /user\s*&&\s*user\.customTheme/);
  assert.match(pageJs, /theme\.THEMES\.find/);
  assert.match(pageJs, /theme\.buildCustomTheme\(rgba\)/);
  assert.match(pageJs, /RGBA\(\$\{rgba\.r\}, \$\{rgba\.g\}, \$\{rgba\.b\}, \$\{compactDecimal\(rgba\.a\)\}\)/);
  assert.match(pageWxml, /palette\.svg/);
  assert.match(pageWxml, /\{\{user\.themeNameText\}\}/);
  assert.match(pageWxml, /style="\{\{user\.themeSwatchStyle\}\}"/);
  assert.match(pageWxss, /\.user-theme-visual\s*\{[\s\S]*background-image:[\s\S]*box-sizing:\s*border-box/);
  assert.match(pageWxml, /user-theme-symbol[\s\S]*palette\.svg/);
  assert.doesNotMatch(pageWxml, /class="theme-swatch"|class="section-icon"/);
});

test("management user detail uses distinct semantic icons with theme and danger treatments", () => {
  assert.match(pageWxml, /user\.wechatBound \? '\/images\/ui-icons\/link\.svg' : '\/images\/ui-icons\/unlink\.svg'/);
  assert.match(pageWxml, /globe\.svg" mode="aspectFit"><\/image><text>网络出口/);
  assert.match(pageWxml, /unlink\.svg" mode="aspectFit"><\/image><\/view>[\s\S]*?<view class="action-copy"><view>解绑微信/);
  assert.equal((pageWxml.match(/\/images\/ui-icons\/link\.svg/g) || []).length, 1);
  assert.match(pageWxss, /\.detail-heading-icon image\s*\{[\s\S]*filter:\s*var\(--theme-icon-filter/);
  assert.match(pageWxss, /\.session-fact image\s*\{[\s\S]*filter:\s*var\(--theme-icon-filter/);
  assert.match(pageWxss, /\.danger-action \.action-icon image\s*\{[\s\S]*filter:\s*invert/);

  ["globe.svg", "unlink.svg"].forEach((name) => {
    const icon = read(`inCircleClient/images/ui-icons/${name}`);
    assert.match(icon, /stroke="#000000"/);
    const colors = Array.from(icon.matchAll(/#[0-9a-fA-F]{6}/g), (match) => match[0]);
    assert.deepEqual(Array.from(new Set(colors)), ["#000000"]);
  });
});

test("management theme card remains compact on narrow screens", () => {
  assert.match(pageWxss, /\.theme-copy\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/s);
  assert.match(pageWxss, /\.theme-value\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(pageWxss, /@media \(max-width:\s*350px\)[\s\S]*\.user-theme-visual/);
});
