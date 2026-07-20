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

test("admin user detail rejects non-super-admin access before querying user data", async () => {
  let queryCount = 0;
  const db = {
    async query() {
      queryCount += 1;
      throw new Error("Database should not be queried");
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "ordinary-openid" },
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", is_super_admin: false },
  });

  await assert.rejects(
    service.adminUserDetail({ userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    (error) => error && error.errCode === "FORBIDDEN"
  );
  assert.equal(queryCount, 0);
});

test("admin user detail normalizes preset and custom themes", async () => {
  const targetUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const cases = [
    {
      row: { theme_key: "theme-ocean", custom_theme_rgba: null },
      expectedThemeKey: "ocean",
      expectedCustomTheme: { r: 47, g: 130, b: 89, a: 1 },
    },
    {
      row: {
        theme_key: "CUSTOM",
        custom_theme_rgba: '{"r":81,"g":150,"b":238,"a":0.356}',
      },
      expectedThemeKey: "custom",
      expectedCustomTheme: { r: 81, g: 150, b: 238, a: 0.36 },
    },
  ];

  for (const scenario of cases) {
    const db = {
      async query(sql) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        if (normalized.startsWith("SELECT users.*")) {
          return {
            rows: [Object.assign({
              id: targetUserId,
              nickname: "主题用户",
              status: "active",
              is_super_admin: false,
            }, scenario.row)],
          };
        }
        if (normalized.startsWith("SELECT membership.id")) return { rows: [] };
        if (normalized.startsWith("UPDATE incircle_account_sessions")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT *, count(*) OVER()")) return { rows: [] };
        if (normalized.startsWith("INSERT INTO incircle_operation_logs")) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected query: ${normalized}`);
      },
    };
    const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
    service.requireUser = async () => ({
      identity: { openid: "admin-openid" },
      user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", is_super_admin: true },
    });

    const detail = await service.adminUserDetail({ userId: targetUserId });

    assert.equal(detail.user.themeKey, scenario.expectedThemeKey);
    assert.deepEqual(detail.user.customTheme, scenario.expectedCustomTheme);
  }
});

test("admin user detail exposes masked account metadata and five public login sessions with a safe audit", async () => {
  const targetUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const queries = [];
  const sessionRows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: targetUserId,
      device_key_hash: "device-hash-must-not-leak",
      login_openid_hash: "openid-hash-must-not-leak",
      token_version: 9,
      access_token: "token-must-not-leak",
      device_name: "iPhone 18 Pro",
      device_brand: "Apple",
      device_model: "iPhone 18 Pro",
      platform: "ios",
      system_version: "iOS 20.0",
      wechat_version: "9.0.0",
      environment_version: "release",
      login_address: "203.0.113.8",
      login_location_source: "wx.getLocation",
      login_latitude: 38.9140038,
      login_longitude: 121.614682,
      login_accuracy_m: 12.5,
      login_location_province: "辽宁省",
      login_location_city: "大连市",
      login_location_district: "沙河口区",
      login_location_detail: "中山路 1 号",
      login_location_captured_at: "2026-07-20T12:00:00.000Z",
      last_login_at: "2026-07-20T12:00:00.000Z",
      created_at: "2026-07-20T11:00:00.000Z",
      expires_at: "2099-07-20T12:00:00.000Z",
      revoked_at: null,
      session_total: 7,
      active_session_count: 3,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      user_id: targetUserId,
      device_key_hash: "second-device-hash-must-not-leak",
      login_openid_hash: "second-openid-hash-must-not-leak",
      token_version: 4,
      device_name: "Windows PC",
      platform: "windows",
      system_version: "Windows 11",
      wechat_version: "4.0.0",
      environment_version: "release",
      login_address: "198.51.100.9",
      last_login_at: "2026-07-19T12:00:00.000Z",
      created_at: "2026-07-19T11:00:00.000Z",
      expires_at: "2099-07-20T12:00:00.000Z",
      revoked_at: "2026-07-19T13:00:00.000Z",
      session_total: 7,
      active_session_count: 3,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      user_id: targetUserId,
      device_name: "Android Phone",
      platform: "android",
      system_version: "Android 17",
      login_address: "192.0.2.10",
      last_login_at: "2026-07-18T12:00:00.000Z",
      created_at: "2026-07-18T11:00:00.000Z",
      expires_at: "2099-07-20T12:00:00.000Z",
      revoked_at: null,
      session_total: 7,
      active_session_count: 3,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      user_id: targetUserId,
      device_name: "iPad",
      platform: "ios",
      system_version: "iPadOS 20",
      login_address: "192.0.2.11",
      last_login_at: "2026-07-17T12:00:00.000Z",
      created_at: "2026-07-17T11:00:00.000Z",
      expires_at: "2099-07-20T12:00:00.000Z",
      revoked_at: null,
      session_total: 7,
      active_session_count: 3,
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      user_id: targetUserId,
      device_name: "Old Mac",
      platform: "mac",
      system_version: "macOS 15",
      login_address: "192.0.2.12",
      last_login_at: "2026-07-16T12:00:00.000Z",
      created_at: "2026-07-16T11:00:00.000Z",
      expires_at: "2026-07-17T12:00:00.000Z",
      revoked_at: null,
      session_total: 7,
      active_session_count: 3,
    },
  ];
  const db = {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT users.*")) {
        return {
          rows: [{
            id: targetUserId,
            openid: "openid-sensitive-value",
            unionid: "unionid-sensitive-value",
            nickname: "用户甲",
            wechat_nickname: "微信用户甲",
            wechat_bound: true,
            wechat_bound_at: "2026-06-01T10:00:00.000Z",
            account_name: "15504089974",
            account_bound_at: "2026-06-02T10:00:00.000Z",
            password_updated_at: "2026-07-01T10:00:00.000Z",
            phone: "15504089974",
            verify_wechat_on_login: false,
            precise_login_location_enabled: true,
            status: "active",
            is_super_admin: false,
            circle_count: 2,
            owned_circle_count: 1,
            created_at: "2026-06-01T10:00:00.000Z",
            last_login_at: "2026-07-20T12:00:00.000Z",
          }],
        };
      }
      if (normalized.startsWith("SELECT membership.id")) return { rows: [] };
      if (normalized.startsWith("UPDATE incircle_account_sessions")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT *, count(*) OVER()")) return { rows: sessionRows };
      if (normalized.startsWith("INSERT INTO incircle_operation_logs")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireUser = async () => ({
    identity: {
      openid: "admin-openid",
      sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
    },
    user: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nickname: "超管",
      is_super_admin: true,
    },
  });

  const detail = await service.adminUserDetail({ userId: targetUserId });

  assert.equal(detail.user.wechatOpenidMasked, "open****alue");
  assert.equal(detail.user.wechatUnionidMasked, "unio****alue");
  assert.equal(detail.user.wechatBoundAt, "2026-06-01T10:00:00.000Z");
  assert.equal(detail.user.accountBoundAt, "2026-06-02T10:00:00.000Z");
  assert.equal(detail.user.passwordUpdatedAt, "2026-07-01T10:00:00.000Z");
  assert.equal(detail.user.verifyWechatOnLogin, false);
  assert.equal(detail.user.preciseLoginLocationEnabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(detail.user, "openid"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(detail.user, "unionid"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(detail.user, "wechatNickName"), false);

  assert.equal(detail.recentLoginSessions.length, 5);
  assert.equal(detail.recentLoginSessions[0].deviceName, "iPhone 18 Pro");
  assert.equal(detail.recentLoginSessions[0].environment, "ios · iOS 20.0 · 微信 9.0.0 · release 版");
  assert.equal(detail.recentLoginSessions[0].loginAddress, "203.0.113.8");
  assert.deepEqual(detail.recentLoginSessions[0].loginLocation, {
    available: true,
    source: "wx.getLocation",
    latitude: 38.9140038,
    longitude: 121.614682,
    accuracyMeters: 12.5,
    province: "辽宁省",
    city: "大连市",
    district: "沙河口区",
    detail: "中山路 1 号",
    capturedAt: "2026-07-20T12:00:00.000Z",
  });
  assert.equal(detail.recentLoginSessions[0].status, "active");
  assert.equal(detail.recentLoginSessions[1].status, "revoked");
  assert.deepEqual(detail.loginSessionSummary, {
    total: 7,
    activeSessionCount: 3,
    shownCount: 5,
    hasMore: true,
  });

  const serialized = JSON.stringify(detail);
  [
    "openid-sensitive-value",
    "unionid-sensitive-value",
    "device-hash-must-not-leak",
    "openid-hash-must-not-leak",
    "token-must-not-leak",
  ].forEach((secret) => assert.doesNotMatch(serialized, new RegExp(secret)));
  ["device_key_hash", "login_openid_hash", "token_version", "access_token"].forEach((field) => {
    assert.doesNotMatch(serialized, new RegExp(field));
  });

  const sessionQuery = queries.find((query) => query.sql.startsWith("SELECT *, count(*) OVER()"));
  assert.deepEqual(sessionQuery.params, [targetUserId, null, 5]);
  const auditQuery = queries.find((query) => query.sql.startsWith("INSERT INTO incircle_operation_logs"));
  assert.equal(auditQuery.params[2], "查看用户敏感详情");
  assert.equal(auditQuery.params[3], "user");
  assert.equal(auditQuery.params[4], targetUserId);
  const auditPayload = JSON.parse(auditQuery.params[5]);
  assert.equal(auditPayload.totalSessionCount, 7);
  assert.equal(auditPayload.returnedSessionCount, 5);
  assert.equal(auditPayload.returnedLocationRecordCount, 1);
  assert.doesNotMatch(JSON.stringify(auditPayload), /203\.0\.113\.8|198\.51\.100\.9|38\.9140038|121\.614682/);
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
      if (normalized.startsWith("UPDATE incircle_account_sessions")) return { rows: [], rowCount: 1 };
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
  assert.equal(queries.some((query) => /UPDATE incircle_account_sessions/.test(query.sql)), true);
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
  const accountPage = read("inCircleClient/pages/account-settings/index.wxml");
  const accountStyles = read("inCircleClient/pages/account-settings/index.wxss");
  const usages = [
    accountPage,
    read("inCircleClient/pages/index/index.wxml"),
    read("inCircleClient/pages/admin/index.wxml"),
    read("inCircleClient/pages/circle-settings/index.wxml"),
  ].join("\n");
  assert.match(icon, /stroke="#000000"/);
  assert.doesNotMatch(usages, /admin\.png/);
  assert.equal((usages.match(/admin\.svg/g) || []).length, 3);
  assert.match(accountStyles, /\.management-icon image,[\s\S]*filter:\s*var\(--theme-icon-filter/s);
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
