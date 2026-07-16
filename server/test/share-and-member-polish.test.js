const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("saved-share sheets use one compact themed header and separated actions", () => {
  const appStyles = read("inCircleClient/app.wxss");
  const templates = [
    read("inCircleClient/pages/activities/index.wxml"),
    read("inCircleClient/pages/tools/index.wxml"),
  ];
  templates.forEach((template) => {
    assert.match(template, /class="share-ready-handle"/);
    assert.match(template, /class="share-ready-head"/);
    assert.match(template, /\/images\/ui-icons\/check\.svg/);
    assert.match(template, /class="share-ready-actions"/);
    assert.match(template, /\/images\/ui-icons\/share\.svg/);
    assert.doesNotMatch(template, /<view class="share-ready-mark">✓<\/view>/);
  });
  assert.match(appStyles, /\.share-ready-actions\s*\{[^}]*display:\s*grid;[^}]*gap:\s*14rpx/s);
  assert.match(appStyles, /\.share-ready-mark image\s*\{[^}]*var\(--theme-icon-filter/s);
  assert.doesNotMatch(appStyles, /\.share-ready-secondary\s*\{[^}]*margin-top:\s*14rpx/s);
});

test("activity cards separate status insight, recap, and semantic actions", () => {
  const template = read("inCircleClient/pages/activities/index.wxml");
  const styles = read("inCircleClient/pages/activities/index.wxss");
  assert.match(template, /class="insight-icon"/);
  assert.match(template, /class="activity-recap"/);
  assert.match(template, /class="activity-actions"/);
  assert.match(template, /class="activity-action share"/);
  assert.match(template, /class="activity-action danger/);
  assert.doesNotMatch(template, /class="recap-row"/);
  assert.match(styles, /\.insight-box\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.activity-action\.share\s*\{[^}]*background:\s*var\(--theme-primary/s);
  assert.match(styles, /\.activity-action\.danger\s*\{[^}]*#fff5f2/s);
});

test("member cards render a themed profile-note placeholder instead of a blank bar", () => {
  const template = read("inCircleClient/pages/members/index.wxml");
  const styles = read("inCircleClient/pages/members/index.wxss");
  assert.match(template, /class="member-note" wx:if="\{\{member\.note\}\}"/);
  assert.match(template, /class="member-note-placeholder" wx:else/);
  assert.match(template, /暂未填写圈内介绍/);
  assert.match(styles, /\.member-note-placeholder\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.member-note-placeholder image\s*\{[^}]*var\(--theme-icon-filter/s);
});
