const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");

const ROOT = path.join(__dirname, "..", "..");
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }

test("management migration and routes expose paginated circle and user administration", () => {
  const migration = read("server/db/migrations/0014_circle_and_user_management.sql");
  const searchUpgrade = read("server/db/migrations/0015_expand_circle_admin_search.sql");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");
  assert.match(migration, /last_entered_at timestamptz/);
  assert.match(migration, /blocked_by_user_id/);
  assert.match(migration, /wechat_unbound_at/);
  assert.doesNotMatch(migration, /COALESCE\(notice, ''\)/);
  assert.match(searchUpgrade, /DROP INDEX IF EXISTS idx_incircle_circles_admin_search_trgm/);
  assert.match(searchUpgrade, /COALESCE\(notice, ''\)/);
  [
    "incircleAdminOverview",
    "incircleAdminListUsers",
    "incircleAdminUserDetail",
    "incircleAdminUpdateUserStatus",
    "incircleAdminUnbindUserWechat",
    "incircleAdminDeleteUser",
    "incircleCircleMemberDetail",
  ].forEach((action) => {
    assert.match(routes, new RegExp(action));
    assert.match(api, new RegExp(action));
  });
});

test("circle member detail returns only current-circle public fields", async () => {
  const db = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT * FROM incircle_circle_members")) {
        return { rows: [{ id: "viewer-membership", role: "圈主", user_id: "viewer-user" }] };
      }
      if (normalized.startsWith("SELECT membership.*")) {
        return {
          rows: [{
            id: "22222222-2222-4222-8222-222222222222",
            circle_id: "11111111-1111-4111-8111-111111111111",
            circle_name: "测试圈子",
            user_id: "target-user",
            openid: "must-not-leak",
            phone: "13800000000",
            member_name: "成员甲",
            member_id_text: "m-008",
            role: "成员",
            joined_at: "2026-07-01T00:00:00.000Z",
            avatar_url: "/images/avatar.png",
            card_title: "摄影担当",
            card_profile_note: "负责拍照",
            tags: ["靠谱"],
            card_payload: { skills: ["摄影"], interests: ["徒步"] },
          }],
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "viewer-openid" },
    user: { id: "viewer-user", current_circle_id: "11111111-1111-4111-8111-111111111111" },
  });
  const member = await service.circleMemberDetail({
    circleId: "11111111-1111-4111-8111-111111111111",
    membershipId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(member.name, "成员甲");
  assert.equal(member.canRemove, true);
  ["openid", "userId", "phone", "accountName", "circles", "isSuperAdmin"].forEach((field) => {
    assert.equal(Object.prototype.hasOwnProperty.call(member, field), false, field);
  });
});

test("blocking a user revokes sessions without changing owned circle status", async () => {
  const queries = [];
  const db = {
    async withTransaction(callback) { return callback(); },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT * FROM incircle_users")) {
        return { rows: [{ id: "target-user", openid: "target-openid", status: "active", is_super_admin: false }] };
      }
      if (normalized.startsWith("UPDATE incircle_users")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireSuperAdmin = async () => ({
    identity: { openid: "admin-openid" },
    user: { id: "admin-user", nickname: "超管" },
  });
  service.logOperation = async () => {};
  service.adminUserDetail = async () => ({ user: { id: "target-user", status: "blocked" } });

  const result = await service.adminUpdateUserStatus({ userId: "11111111-1111-4111-8111-111111111111", status: "blocked" });
  const update = queries.find((query) => query.sql.startsWith("UPDATE incircle_users"));
  assert.match(update.sql, /logged_in = false/);
  assert.match(update.sql, /auth_version = auth_version \+ 1/);
  assert.equal(update.params[1], "blocked");
  assert.equal(queries.some((query) => /UPDATE incircle_circles/.test(query.sql)), false);
  assert.equal(result.user.status, "blocked");
});

test("shared dialog uses a real spacer and typed destructive confirmation", () => {
  const css = read("inCircleClient/components/theme-dialog/index.wxss");
  const wxml = read("inCircleClient/components/theme-dialog/index.wxml");
  const js = read("inCircleClient/components/theme-dialog/index.js");
  assert.match(css, /\.theme-dialog-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.theme-dialog-action-spacer\s*\{[^}]*flex:\s*0 0 16rpx/s);
  assert.match(wxml, /theme-dialog-action-spacer/);
  assert.doesNotMatch(css, /\.cancel-button\s*\{[^}]*margin-right/s);
  assert.match(wxml, /verification-input/);
  assert.match(js, /confirmDisabled/);
  assert.match(css, /\.confirm-button\[disabled\]\s*\{[^}]*color:[^;]*!important;[^}]*opacity:\s*1;/s);
  assert.match(css, /\.tone-danger \.confirm-button\[disabled\]\s*\{[^}]*background:\s*#fae9e7;[^}]*color:\s*#984541\s*!important;/s);
});

test("shared dialog renders only danger and primary tones", () => {
  const css = read("inCircleClient/components/theme-dialog/index.wxss");
  const js = read("inCircleClient/components/theme-dialog/index.js");
  const circleSettings = read("inCircleClient/pages/circle-settings/index.js");
  const adminUser = read("inCircleClient/pages/admin-user-detail/index.js");

  assert.match(js, /primary:\s*"default"/);
  assert.match(js, /error:\s*"danger"/);
  assert.match(js, /warning:\s*"danger"/);
  assert.match(js, /info:\s*"default"/);
  assert.match(js, /const DANGER_WORDS = \/[^/]*删除[^/]*失败[^/]*停用[^/]*归档[^/]*封禁[^/]*解绑[^/]*\//);
  assert.doesNotMatch(js, /WARNING_WORDS|return "warning"/);

  assert.match(css, /\.confirm-button\s*\{[^}]*var\(--dialog-primary[^}]*var\(--dialog-primary-dark/s);
  assert.match(css, /\.tone-danger \.confirm-button\s*\{[^}]*background:\s*#c94747;/s);
  assert.doesNotMatch(css, /\.tone-warning|\.symbol-info/);

  assert.match(circleSettings, /title:\s*"更换邀请码"[\s\S]*?tone:\s*"primary"/);
  assert.match(circleSettings, /title:\s*"退出圈子"[\s\S]*?tone:\s*"danger"/);
  assert.match(adminUser, /tone:\s*blocking \? "danger" : "default"/);
});

test("management center uses one theme-aware monochrome icon", () => {
  const icon = read("inCircleClient/images/ui-icons/admin.svg");
  const switchPage = read("inCircleClient/pages/circle-switch/index.wxml");
  const switchStyles = read("inCircleClient/pages/circle-switch/index.wxss");
  const usages = [
    switchPage,
    read("inCircleClient/pages/index/index.wxml"),
    read("inCircleClient/pages/admin/index.wxml"),
    read("inCircleClient/pages/circle-settings/index.wxml"),
  ].join("\n");
  assert.match(icon, /stroke="#000000"/);
  assert.doesNotMatch(usages, /admin\.png/);
  assert.equal((usages.match(/admin\.svg/g) || []).length, 4);
  assert.match(switchStyles, /\.management-icon image\s*\{[^}]*filter:\s*var\(--theme-icon-filter/s);
});

test("management pages are registered and the old member search is removed", () => {
  const app = JSON.parse(read("inCircleClient/app.json"));
  [
    "pages/my-circles/index",
    "pages/circle-member/index",
    "pages/admin-circles/index",
    "pages/admin-users/index",
    "pages/admin-user-detail/index",
  ].forEach((page) => assert.equal(app.pages.includes(page), true, page));
  const adminPage = read("inCircleClient/pages/admin/index.wxml");
  const routes = read("server/src/routes/incircle.js");
  assert.match(adminPage, /管理所有圈子/);
  assert.match(adminPage, /用户管理/);
  assert.doesNotMatch(adminPage, /成员检索/);
  assert.doesNotMatch(routes, /incircleAdminListMembers/);
});

test("member removal uses membership ids and no longer accepts OpenID fallback", () => {
  const service = read("server/src/services/incircle.js");
  const settingsPage = read("inCircleClient/pages/circle-settings/index.js");
  const adminCircles = read("inCircleClient/pages/admin-circles/index.wxml");
  assert.match(service, /membership\.id = \$2/);
  assert.doesNotMatch(service, /body\.targetOpenid \|\| body\.openid/);
  assert.doesNotMatch(settingsPage, /memberRemovingOpenid|removeMember\(e\)/);
  assert.doesNotMatch(adminCircles, /'status:' \+ item\.id|'delete:' \+ item\.id/);
});

test("physical user deletion anonymizes creator fields and keeps cleanup best effort", () => {
  const service = read("server/src/services/incircle.js");
  ["hostName", "authorName", "createdByName", "ownerName"].forEach((field) => {
    assert.match(service, new RegExp(`${field}: \\"已删除用户\\"`));
  });
  assert.match(service, /bestEffortCleanupManagedUploads/);
  assert.match(service, /用户媒体清理待处理[\s\S]*\.catch\(\(\) => \{\}\)/);
});

test("upload authentication revokes stale tokens and limits code uploads to account setup", () => {
  const media = read("server/src/routes/media.js");
  assert.match(media, /identity\.authVersion[\s\S]*TOKEN_REVOKED/);
  assert.match(media, /token && \(!user \|\| user\.status !== "active" \|\| !user\.logged_in\)/);
  assert.match(media, /!token && \(!isAvatar \|\| hasBoundAccount\)/);
});
