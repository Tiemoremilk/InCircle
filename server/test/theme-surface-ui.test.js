const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function cssBlock(styles, selector) {
  const start = styles.indexOf(selector);
  assert.notEqual(start, -1, `missing selector ${selector}`);
  const open = styles.indexOf("{", start + selector.length);
  const close = styles.indexOf("}", open + 1);
  return styles.slice(open + 1, close);
}

test("themed hero pills keep white contrast without changing card pills", () => {
  const templates = [
    "pages/circle-settings/index.wxml",
    "pages/member-detail/index.wxml",
    "pages/doc-detail/index.wxml",
    "pages/checkin-detail/index.wxml",
    "pages/vote-detail/index.wxml",
    "pages/bill-detail/index.wxml",
    "pages/activity-detail/index.wxml",
  ];
  templates.forEach((relativePath) => {
    const template = read(`inCircleClient/${relativePath}`);
    assert.match(template, /class="pill hero-pill [^"]+"/, relativePath);
  });

  const circleSettings = read("inCircleClient/pages/circle-settings/index.wxml");
  assert.equal((circleSettings.match(/hero-pill/g) || []).length, 1, "member rows must keep normal card pills");
  assert.match(circleSettings, /class="pill \{\{item\.roleClass\}\}"/);

  const styles = read("inCircleClient/app.wxss");
  const heroRule = cssBlock(styles, ".page .hero-pill,");
  assert.match(heroRule, /background:\s*rgba\(255, 255, 255, 0\.17\)/);
  assert.match(heroRule, /border:\s*1rpx solid rgba\(255, 255, 255, 0\.5\)/);
  assert.match(heroRule, /color:\s*#ffffff/);
  assert.ok(styles.indexOf(".page .hero-pill,") > styles.indexOf(".page .pill-green,"));
  ["pill-green", "pill-blue", "pill-amber", "pill-red"].forEach((variant) => {
    assert.match(styles, new RegExp(`\\.page \\.hero-pill\\.${variant}`));
  });
});

test("member editor follows the shared form layout and hides the custom tabbar", () => {
  const template = read("inCircleClient/pages/members/index.wxml");
  const styles = read("inCircleClient/pages/members/index.wxss");
  const script = read("inCircleClient/pages/members/index.js");
  const tabbarTemplate = read("inCircleClient/custom-tab-bar/index.wxml");
  const tabbarScript = read("inCircleClient/custom-tab-bar/index.js");
  const tabbarStyles = read("inCircleClient/custom-tab-bar/index.wxss");

  const sheetStart = template.indexOf('<view class="edit-sheet"');
  const head = template.indexOf('<view class="sheet-head">', sheetStart);
  const form = template.indexOf('<view class="form-grid">', head);
  const submit = template.indexOf('class="primary-btn sheet-submit', form);
  assert.ok(sheetStart >= 0 && head > sheetStart && form > head && submit > form);
  assert.doesNotMatch(template, /edit-sheet-scroll|edit-section|sheet-actions/);
  assert.match(template, /class="sheet-mask" style="bottom: 0;"/);
  assert.equal((template.match(/class="field-row"/g) || []).length, 3);

  ["tagsText", "skillsText", "interestsText", "taboosText"].forEach((field) => {
    assert.match(template, new RegExp(`<input[^>]+data-field="${field}"`));
    assert.doesNotMatch(template, new RegExp(`<textarea[^>]+data-field="${field}"`));
  });
  assert.match(template, /class="sheet-close[^"]*"[\s\S]*?images\/ui-icons\/close\.svg/);
  assert.match(template, /class="primary-btn sheet-submit/);
  assert.match(template, /class="field avatar-field-wrap"/);
  assert.match(template, /class="avatar-card [^"]*"/);
  assert.match(template, /<button[\s\S]*?class="avatar-card-action"[\s\S]*?open-type="chooseAvatar"[\s\S]*?bindchooseavatar="onChooseCardAvatar"[\s\S]*?images\/ui-icons\/camera\.svg/);
  assert.doesNotMatch(template, /avatar-picker-hitbox/);
  assert.doesNotMatch(template, /avatar-camera-badge|avatar-change-action|chevron-right\.svg/);
  assert.doesNotMatch(template, /class="edit-avatar-button/);

  const maskRule = cssBlock(styles, ".members-page .sheet-mask");
  const sheetRule = cssBlock(styles, ".edit-sheet");
  assert.match(maskRule, /inset:\s*0/);
  assert.match(maskRule, /z-index:\s*1200/);
  assert.match(sheetRule, /max-height:\s*88vh/);
  assert.match(sheetRule, /overflow-y:\s*auto/);
  assert.match(styles, /\.form-grid\s*\{[^}]*display:\s*grid;[^}]*gap:\s*18rpx/s);
  assert.match(styles, /\.form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(styles, /\.avatar-card\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*12rpx/s);
  assert.match(styles, /\.avatar-card-action\s*\{[^}]*width:\s*62rpx;[^}]*max-width:\s*62rpx;[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--theme-primary/s);
  assert.match(styles, /\.avatar-card-action::after\s*\{[^}]*border:\s*0;/s);
  assert.match(styles, /\.avatar-card-action image\s*\{[^}]*filter:\s*brightness\(0\) invert\(1\)/s);
  assert.doesNotMatch(styles, /\.avatar-picker-hitbox\s*\{/);
  assert.match(styles, /\.field-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.ok(Number(maskRule.match(/z-index:\s*(\d+)/)[1]) > Number(tabbarStyles.match(/z-index:\s*(\d+)/)[1]));
  assert.match(script, /function listToText\(list\)[\s\S]*join\("、"\)/);
  assert.match(script, /closeEditSheet\(\)\s*\{\s*if \(this\.data\.avatarUploading \|\| this\.data\.cardSaving\) return;/);
  assert.match(script, /onChooseCardAvatar\(e\)\s*\{\s*if \(this\.data\.avatarUploading \|\| this\.data\.cardSaving\) return;/);
  assert.match(script, /editCard\(\)\s*\{\s*this\.setTabBarHidden\(true\)/);
  assert.match(script, /setTabBarHidden\(false\)/);
  assert.match(tabbarScript, /hidden:\s*false/);
  assert.match(tabbarTemplate, /wx:if="\{\{!hidden\}\}"/);
});

test("custom theme picker uses real derived colors and fixed actions", () => {
  const template = read("inCircleClient/pages/circle-switch/index.wxml");
  const styles = read("inCircleClient/pages/circle-switch/index.wxss");
  const script = read("inCircleClient/pages/circle-switch/index.js");
  const closeIcon = read("inCircleClient/images/ui-icons/close.svg");

  const head = template.indexOf('<view class="custom-theme-head">');
  const body = template.indexOf('<view class="custom-theme-body">');
  const actions = template.indexOf('<view class="custom-theme-actions">', body);
  assert.ok(head >= 0 && body > head && actions > body);
  assert.match(template, /<\/view>\s*<\/view>\s*<view class="custom-theme-actions">/);
  assert.doesNotMatch(template, /<scroll-view class="custom-theme-body"/);
  assert.match(template, /class="custom-theme-stage" style="\{\{customThemeHeroStyle\}\}"/);
  assert.match(template, /customThemeDarkStyle/);
  assert.match(template, /customThemePrimaryStyle/);
  assert.match(template, /customThemeAccentStyle/);
  assert.match(template, /activeColor="#d85b57"[^>]+data-channel="r"/);
  assert.match(template, /activeColor="#32936f"[^>]+data-channel="g"/);
  assert.match(template, /activeColor="#477fbd"[^>]+data-channel="b"/);
  assert.match(template, /customThemeActionStyle/);

  const sheetRule = cssBlock(styles, ".custom-theme-sheet");
  const bodyRule = cssBlock(styles, ".custom-theme-body");
  assert.match(sheetRule, /display:\s*flex/);
  assert.match(sheetRule, /overflow:\s*hidden/);
  assert.match(sheetRule, /height:\s*auto/);
  assert.match(sheetRule, /max-height:\s*calc\(100% - 56rpx\)/);
  assert.match(bodyRule, /height:\s*auto/);
  assert.match(bodyRule, /flex:\s*0 0 auto/);
  assert.match(bodyRule, /overflow:\s*visible/);
  assert.match(template, /custom-theme-stage-samples/);
  assert.match(template, /custom-theme-alpha-chip/);
  assert.match(template, /customThemeStageButtonStyle/);
  assert.match(template, /customThemeAlphaStyle/);
  assert.match(styles, /\.custom-channel-panel\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.86\)/s);
  assert.match(styles, /\.custom-theme-actions\s*\{[^}]*display:\s*grid;[^}]*safe-area-inset-bottom/s);
  assert.match(script, /theme\.buildCustomTheme\(rgba\)/);
  assert.match(script, /customThemeHeroStyle/);
  assert.match(script, /this\.setData\(\{ themeSaving: true \}\)/);
  assert.match(script, /customThemeOpen:\s*false/);
  assert.match(closeIcon, /stroke="#000000"/);
});
