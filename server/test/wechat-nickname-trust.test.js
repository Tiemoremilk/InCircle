const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");

const ROOT = path.resolve(__dirname, "../..");

function createService(existingUser) {
  const queries = [];
  const service = Object.create(InCircleService.prototype);
  service.getUserByOpenid = async () => existingUser || null;
  service.isSuperAdmin = () => false;
  service.db = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          openid: params[0],
          unionid: params[1],
          nickname: params[2],
          wechat_nickname: existingUser ? existingUser.wechat_nickname : "",
        }],
      };
    },
  };
  return { queries, service };
}

function prepareAuthenticationPath(service) {
  service.resolveIdentity = async () => ({ openid: "openid-new", unionid: "unionid-new" });
  service.currentLegalProfile = async () => ({ termsVersion: "terms-v1", privacyVersion: "privacy-v1" });
  service.enforceAuthRateLimit = () => {};
  service.assertAccountAvailable = async () => {};
  service.syncClientThemePreference = async (user) => user;
  service.saveAccountCredentials = async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    openid: "openid-new",
    theme_key: "forest",
  });
  service.establishLoginSession = async () => {};
  service.buildSession = (user) => ({ user });
}

test("registration and binding ignore client-provided WeChat nickname", async () => {
  const maliciousWechatName = "forged-client-wechat-name";
  for (const method of ["registerAccount", "bindAccount"]) {
    const { queries, service } = createService(null);
    prepareAuthenticationPath(service);
    await service[method]({
      account: "test-account",
      password: "password1",
      agreementAcceptance: {
        accepted: true,
        termsVersion: "terms-v1",
        privacyVersion: "privacy-v1",
      },
      profile: {
        nickName: "用户手填昵称",
        wechatNickName: maliciousWechatName,
        phone: "13800138000",
        title: "称号",
        profileNote: "备注",
        avatarUrl: "/images/avatar.png",
      },
    });

    assert.equal(queries.length, 1, method);
    assert.doesNotMatch(queries[0].sql, /wechat_nickname/i, method);
    assert.equal(queries[0].params.includes(maliciousWechatName), false, method);
    assert.equal(queries[0].params[2], "用户手填昵称", method);
  }
});

test("legacy client payload cannot overwrite a future trusted server-side WeChat nickname", async () => {
  const trustedWechatName = "可信服务端微信名";
  const maliciousWechatName = "旧客户端伪造微信名";
  const { queries, service } = createService({
    id: "11111111-1111-4111-8111-111111111111",
    openid: "openid-existing",
    nickname: "原昵称",
    wechat_nickname: trustedWechatName,
    phone: "",
    title: "",
    profile_note: "",
    theme_key: "forest",
    avatar_url: "/images/avatar.png",
  });

  const user = await service.upsertWechatUser(
    { openid: "openid-existing", unionid: "" },
    { nickName: "更新后的手填昵称", wechatNickName: maliciousWechatName }
  );

  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].sql, /wechat_nickname/i);
  assert.equal(queries[0].params.includes(maliciousWechatName), false);
  assert.equal(user.wechat_nickname, trustedWechatName);
});

test("0037 clears historical untrusted values once while fresh schema stays empty by default", () => {
  const migration = fs.readFileSync(
    path.join(ROOT, "server/db/migrations/0037_clear_untrusted_wechat_nickname.sql"),
    "utf8"
  );
  const schema = fs.readFileSync(path.join(ROOT, "server/db/schema.sql"), "utf8");
  const migrate = fs.readFileSync(path.join(ROOT, "server/src/migrate.js"), "utf8");
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  assert.equal(statements.length, 1);
  assert.match(statements[0], /^UPDATE incircle_users\s+SET wechat_nickname = ''\s+WHERE wechat_nickname IS DISTINCT FROM ''$/i);
  assert.doesNotMatch(migration, /ALTER\s+TABLE|ADD\s+COLUMN|SET\s+DEFAULT/i);
  assert.match(schema, /wechat_nickname text NOT NULL DEFAULT ''/);
  assert.match(migrate, /CREATE TABLE IF NOT EXISTS incircle_schema_migrations/);
  assert.match(migrate, /if \(!appliedChecksum\) await applyVersionedMigration\(db, migration\)/);
});
