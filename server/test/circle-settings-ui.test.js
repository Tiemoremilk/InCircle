const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pageRoot = path.resolve(__dirname, "../../inCircleClient/pages/circle-settings");

function read(file) {
  return fs.readFileSync(path.join(pageRoot, file), "utf8");
}

test("circle invitation uses a compact themed code bar with semantic actions", () => {
  const template = read("index.wxml");
  const styles = read("index.wxss");
  const script = read("index.js");

  assert.match(template, /class="invite-panel"/);
  assert.match(template, /class="invite-code-row [^"]*" bindtap="copyInviteCode"/);
  assert.match(template, /\/images\/ui-icons\/copy\.svg/);
  assert.match(template, /\/images\/ui-icons\/share\.svg/);
  assert.match(template, /\/images\/ui-icons\/qr-code\.svg/);
  assert.match(template, /open-type="share"/);
  assert.match(template, /bindtap="handleInviteQrAction"/);
  assert.match(template, /catchtap="rotateInviteCode"/);
  assert.match(template, /wx:if="\{\{canManage\}\}"[\s\S]*?invite-rotate-action/);
  assert.doesNotMatch(template, /invite-head-note|>CIRCLE</);

  assert.match(styles, /\.invite-code-row\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.invite-action-primary\s*\{[^}]*background:\s*var\(--theme-primary/s);
  assert.match(styles, /\.invite-action-secondary\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.invite-rotate-action\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.doesNotMatch(styles, /\.invite-row\s*\{|border:\s*1rpx dashed/);

  assert.match(script, /handleInviteQrAction\(\)\s*\{[\s\S]*this\.previewInviteQrCode\(\)/);
  assert.match(script, /inviteQrButtonText:\s*"查看入圈码"/);
  assert.match(script, /title:\s*"更换邀请码"/);
  assert.match(script, /tone:\s*"warning"/);
  assert.match(script, /\.rotateInviteCode\(this\.data\.circle\.id\)/);
});

test("member permissions use a separated themed heading and member list", () => {
  const template = read("index.wxml");
  const styles = read("index.wxss");

  assert.match(template, /class="member-section-head"/);
  assert.match(template, /class="member-heading-icon"/);
  assert.match(template, /\/images\/ui-icons\/members\.svg/);
  assert.match(template, /class="member-count">\{\{members\.length\}\} 人/);
  assert.match(template, /class="member-list" wx:if="\{\{members\.length\}\}"/);
  assert.match(styles, /\.member-heading-icon image\s*\{[^}]*filter:\s*var\(--theme-icon-filter/s);
  assert.match(styles, /\.member-list\s*\{[^}]*margin-top:\s*20rpx/s);
  assert.match(styles, /\.settings-page \.member-list \.member-row\s*\{[^}]*border-top:\s*0/s);
});
