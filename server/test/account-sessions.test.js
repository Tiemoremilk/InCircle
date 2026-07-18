const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const fastifyFactory = require("fastify");

const {
  establishAccountSession,
  listAccountSessions,
  loginAddressFromRequest,
  requireActiveAccountSession,
  revokeAccountSession,
  sessionMatchesBoundWechat,
  sha256,
} = require("../src/account-sessions");
const { issueAccessToken, verifyAccessToken } = require("../src/auth");
const { InCircleService } = require("../src/services/incircle");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("login addresses trust exactly one reverse-proxy hop", async () => {
  const app = fastifyFactory({ logger: false, trustProxy: 1 });
  app.get("/ip", async (request) => ({ address: loginAddressFromRequest(request) }));

  const ordinary = await app.inject({
    method: "GET",
    url: "/ip",
    headers: { "x-forwarded-for": "198.51.100.24" },
  });
  assert.equal(ordinary.json().address, "198.51.100.24");

  const spoofedPrefix = await app.inject({
    method: "GET",
    url: "/ip",
    headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.24" },
  });
  assert.equal(spoofedPrefix.json().address, "198.51.100.24");

  await app.close();
});

test("account sessions upsert one hashed row per installation and issue revocable JWTs", async () => {
  const queries = [];
  const expiresAt = new Date(Date.now() + 3600000);
  const sessionRow = {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: "11111111-1111-4111-8111-111111111111",
    token_version: 4,
    expires_at: expiresAt,
  };
  const db = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/INSERT INTO incircle_account_sessions/.test(sql)) return { rows: [sessionRow] };
      if (/DELETE FROM incircle_account_sessions/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const user = {
    id: sessionRow.user_id,
    openid: "bound-openid",
    auth_version: 7,
  };
  const identity = { openid: "observed-openid" };
  const rawDeviceKey = "device-installation-key-1234567890";
  const session = await establishAccountSession(
    db,
    { jwtTtlSeconds: 3600 },
    { ip: "::ffff:203.0.113.9", headers: { "x-incircle-env-version": "release" } },
    user,
    identity,
    {
      deviceContext: {
        deviceKey: rawDeviceKey,
        brand: "Example",
        model: "Phone 1",
        platform: "android",
        system: "Android 16",
        wechatVersion: "9.0.0",
      },
    }
  );
  const insert = queries.find((query) => /INSERT INTO incircle_account_sessions/.test(query.sql));
  assert.equal(insert.params[1], sha256(rawDeviceKey));
  assert.equal(insert.params.includes(rawDeviceKey), false);
  assert.equal(insert.params[11], "203.0.113.9");
  assert.match(insert.sql, /ON CONFLICT \(user_id, device_key_hash\)/);
  assert.match(insert.sql, /token_version = incircle_account_sessions\.token_version \+ 1/);
  assert.equal(session.id, sessionRow.id);

  const config = { jwtSecret: "x".repeat(48), jwtTtlSeconds: 3600 };
  const access = issueAccessToken(config, user, session);
  const verified = verifyAccessToken(config, access.token);
  assert.equal(verified.userId, user.id);
  assert.equal(verified.sessionId, session.id);
  assert.equal(verified.sessionVersion, 4);
  assert.equal(verified.tokenVersion, 2);
});

test("session validation and revocation are enforced by server-side session id", async () => {
  const identity = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    sessionVersion: 3,
  };
  const userId = "11111111-1111-4111-8111-111111111111";
  const active = {
    id: identity.sessionId,
    user_id: userId,
    token_version: 3,
    expires_at: new Date(Date.now() + 60000),
    revoked_at: null,
  };
  const db = { async query() { return { rows: [active] }; } };
  assert.equal((await requireActiveAccountSession(db, identity, userId)).id, active.id);

  await assert.rejects(
    () => requireActiveAccountSession({ async query() { return { rows: [{ ...active, revoked_at: new Date() }] }; } }, identity, userId),
    (error) => error.errCode === "ACCOUNT_SESSION_REVOKED" && error.statusCode === 401
  );
  await assert.rejects(
    () => revokeAccountSession(db, userId, identity.sessionId, identity.sessionId),
    (error) => error.errCode === "CURRENT_SESSION_CANNOT_REVOKE" && error.statusCode === 409
  );
  assert.equal(sessionMatchesBoundWechat({ login_openid_hash: sha256("bound") }, { openid: "bound" }), true);
  assert.equal(sessionMatchesBoundWechat({ login_openid_hash: sha256("other") }, { openid: "bound" }), false);

  const publicRows = await listAccountSessions({
    async query() {
      return { rows: [{
        ...active,
        device_key_hash: sha256("private-device-key"),
        login_openid_hash: sha256("private-openid"),
        device_name: "Example Phone",
        login_address: "203.0.113.9",
        last_login_at: new Date(),
      }] };
    },
  }, userId, active.id);
  assert.equal(Object.hasOwn(publicRows[0], "device_key_hash"), false);
  assert.equal(Object.hasOwn(publicRows[0], "login_openid_hash"), false);
});

test("a WeChat code cannot bypass a revoked or missing account session", async () => {
  const service = new InCircleService({
    config: {},
    db: { async query() { throw new Error("business auth must stop before database lookup"); } },
  }, {});
  service.resolveIdentity = async () => ({ source: "wechat", openid: "openid-from-code" });
  await assert.rejects(
    () => service.requireUser({ wechatLoginCode: "one-time-code" }),
    (error) => error.errCode === "AUTH_REQUIRED" && error.statusCode === 401
  );
});

test("account settings, login verification, and device management are wired end to end", () => {
  const migration = read("server/db/migrations/0033_account_device_sessions.sql");
  const schema = read("server/db/schema.sql");
  const service = read("server/src/services/incircle.js");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");
  const auth = read("inCircleClient/utils/auth.js");
  const appSource = read("server/src/app.js");
  const rootReadme = read("README.md");
  const serverReadme = read("server/README.md");
  const page = read("inCircleClient/pages/account-settings/index.wxml");
  const pageScript = read("inCircleClient/pages/account-settings/index.js");
  const pageStyles = read("inCircleClient/pages/account-settings/index.wxss");
  const home = read("inCircleClient/pages/index/index.wxml");
  const circles = read("inCircleClient/pages/circle-switch/index.wxml");
  const app = JSON.parse(read("inCircleClient/app.json"));

  [migration, schema].forEach((sql) => {
    assert.match(sql, /verify_wechat_on_login boolean NOT NULL DEFAULT true/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_account_sessions/);
    assert.match(sql, /UNIQUE \(user_id, device_key_hash\)/);
    assert.match(sql, /login_address text NOT NULL DEFAULT ''/);
    assert.match(sql, /ON DELETE CASCADE/);
  });
  assert.match(routes, /case "incircleAccountSettings"/);
  assert.match(routes, /case "incircleUpdateWechatLoginVerification"/);
  assert.match(routes, /case "incircleRevokeLoginSession"/);
  assert.match(service, /user\.verify_wechat_on_login !== false && user\.openid !== identity\.openid/);
  assert.match(service, /async updateWechatLoginVerification\(body\)[\s\S]*verifyPassword\(auth\.user, password\)/);
  assert.match(service, /CURRENT_SESSION_CANNOT_REVOKE|revokeAccountSession/);

  const loginStart = service.indexOf("async accountLogin(body)");
  const loginEnd = service.indexOf("async bindAccount(body)", loginStart);
  const loginBlock = service.slice(loginStart, loginEnd);
  const ordinaryLogin = loginBlock.slice(loginBlock.lastIndexOf("user = await this.syncClientThemePreference"));
  assert.doesNotMatch(ordinaryLogin, /auth_version = auth_version \+ 1/);
  assert.match(api, /const loginCodePromise = anonymous \|\| !forceWechatCode/);
  assert.doesNotMatch(api, /forceWechatCode: true, authRetried: true/);
  assert.match(auth, /ACCOUNT_SESSION_REVOKED/);
  assert.match(appSource, /trustProxy:\s*1/);
  [rootReadme, serverReadme].forEach((document) => {
    assert.match(document, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  });

  assert.equal(app.pages.includes("pages/account-settings/index"), true);
  assert.match(home, /bindtap="openAccountSettings"[\s\S]*账号设置/);
  assert.doesNotMatch(home, /超管后台/);
  assert.match(circles, /class="overview-account"[\s\S]*账号设置/);
  assert.doesNotMatch(circles, /管理中心|class="theme-picker|账号管理/);
  assert.match(page, /登录时校验绑定微信/);
  assert.match(page, /同一设备只保留最近一次记录/);
  assert.match(page, /item\.current[\s\S]*当前设备|statusText/);
  assert.match(page, /session-title-line[\s\S]*session-controls[\s\S]*session-status[\s\S]*session-revoke/);
  assert.match(page, /管理中心/);
  assert.match(page, /主题外观/);
  assert.match(pageScript, /confirmDisableWechatVerification\(\)[\s\S]*verificationPassword/);
  assert.match(pageScript, /revokeSession\(e\)/);
  assert.match(pageStyles, /var\(--theme-primary/);
  assert.match(pageStyles, /\.session-controls\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(pageStyles, /\.session-status\s*\{[^}]*height:\s*36rpx;/s);
  assert.match(pageStyles, /\.session-revoke\s*\{[^}]*height:\s*36rpx;/s);
  assert.match(pageStyles, /env\(safe-area-inset-bottom\)/);
});
