const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("circle join uses themed semantic icons and a balanced public preview", () => {
  const template = read("inCircleClient/pages/circle-join/index.wxml");
  const styles = read("inCircleClient/pages/circle-join/index.wxss");
  const keyIcon = read("inCircleClient/images/ui-icons/key-round.svg");
  const eyeIcon = read("inCircleClient/images/ui-icons/eye.svg");

  assert.match(template, /images\/ui-icons\/key-round\.svg/);
  assert.match(template, /images\/ui-icons\/eye\.svg/);
  assert.doesNotMatch(template, /images\/ui-icons\/(?:share|docs)\.png/);
  assert.match(keyIcon, /<circle[^>]+r="4\.5"/);
  assert.match(eyeIcon, /<circle[^>]+r="3"/);

  assert.match(template, /class="invite-circle-name">\{\{circle\.name\}\}/);
  assert.match(template, /圈子已确认/);
  assert.doesNotMatch(template, /circle\.ownerName|\}\}邀请/);

  assert.match(template, /\{\{circle\.memberCount\}\}[\s\S]*圈内成员/);
  assert.match(template, /\{\{circle\.monthlyActivityCount\}\}[\s\S]*本月约局/);
  assert.match(template, /\{\{circle\.unsettledCount\}\}[\s\S]*待结清/);
  assert.doesNotMatch(template, /class="preview-row"|class="preview-title"/);

  assert.match(styles, /\.join-heading-icon,[\s\S]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.join-heading-icon image,[\s\S]*filter:\s*var\(--theme-icon-filter/s);
  assert.match(styles, /\.preview-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.preview-status\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.preview-metric-value\s*\{[^}]*color:\s*var\(--theme-primary-dark/s);
});
