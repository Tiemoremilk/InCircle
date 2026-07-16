const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { types: pgTypes } = require("pg");

const ROOT = path.resolve(__dirname, "../..");
const serverLegal = require("../src/legal");
const { readPublicLegalProfile, reconcilePublicLegalProfile } = require("../src/legal-profile");
const { InCircleService } = require("../src/services/incircle");
const clientLegal = require("../../inCircleClient/utils/legal");

const TEST_LEGAL_PROFILE = {
  operatorName: "测试运营者",
  contactEmail: "legal@example.test",
  termsVersion: "terms-test-v1",
  privacyVersion: "privacy-test-v1",
  effectiveDate: "2099-01-02",
};

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("account agreements use synchronized versions and explicit acceptance", () => {
  assert.throws(
    () => serverLegal.currentAgreementVersions({}),
    (error) => error.errCode === "PUBLIC_LEGAL_PROFILE_NOT_CONFIGURED" && error.statusCode === 503
  );

  assert.throws(
    () => serverLegal.requireAgreementAcceptance({}, "login", TEST_LEGAL_PROFILE),
    (error) => error.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED" && error.statusCode === 428
  );
  assert.throws(
    () => serverLegal.requireAgreementAcceptance({ agreementAcceptance: {
      accepted: true,
      termsVersion: "old",
      privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    } }, "login", TEST_LEGAL_PROFILE),
    (error) => error.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED"
  );

  const accepted = serverLegal.requireAgreementAcceptance({ agreementAcceptance: {
    accepted: true,
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
  } }, "register", TEST_LEGAL_PROFILE);
  assert.equal(accepted.source, "register");
  assert.equal(serverLegal.agreementStatus({
    terms_version: TEST_LEGAL_PROFILE.termsVersion,
    privacy_version: TEST_LEGAL_PROFILE.privacyVersion,
    agreements_accepted_at: new Date().toISOString(),
  }, TEST_LEGAL_PROFILE).accepted, true);
});

test("agreement consent is versioned in schema and every authentication path", () => {
  const migration = read("server/db/migrations/0022_account_agreements.sql");
  const schema = read("server/db/schema.sql");
  const service = read("server/src/services/incircle.js");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");

  [migration, schema].forEach((sql) => {
    assert.match(sql, /terms_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /privacy_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /agreements_accepted_at timestamptz/);
    assert.match(sql, /agreement_acceptance_source text NOT NULL DEFAULT ''/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_account_agreement_acceptances/);
    assert.match(sql, /UNIQUE \(user_id, terms_version, privacy_version\)/);
    assert.match(sql, /CREATE TRIGGER trg_incircle_users_record_agreement_acceptance/);
    assert.doesNotMatch(sql, /user_agent|ip_address|device_fingerprint/);
  });
  ["register", "login", "bind", "reset"].forEach((source) => {
    assert.match(service, new RegExp(`requireAgreementAcceptance\\(body, "${source}", await this\\.currentLegalProfile\\(\\)\\)`));
  });
  assert.match(service, /async acceptAgreements\(body\)[\s\S]*requireAgreementAcceptance\(body, "session", await this\.currentLegalProfile\(\)\)/);
  assert.match(service, /agreementsAccepted:\s*agreements\.accepted/);
  assert.match(routes, /case "incircleAcceptAgreements"/);
  assert.match(api, /function acceptAgreements\(agreementAcceptance\)/);
  assert.match(api, /incircleAcceptAgreements:\s*\["incircleSession"\]/);
});

test("an authenticated legacy session records current agreement metadata before continuing", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  let captured = null;
  const service = new InCircleService({
    config: {},
    db: {
      async query(sql, params) {
        captured = { sql: String(sql).replace(/\s+/g, " ").trim(), params };
        return {
          rows: [{
            id: userId,
            status: "active",
            terms_version: params[1],
            privacy_version: params[2],
            agreements_accepted_at: new Date().toISOString(),
            agreement_acceptance_source: params[3],
          }],
        };
      },
    },
  }, {});
  service.requireUser = async () => ({ user: { id: userId } });
  service.currentLegalProfile = async () => TEST_LEGAL_PROFILE;
  service.buildSession = async (user) => ({
    user,
    agreementsAccepted: serverLegal.agreementStatus(user, TEST_LEGAL_PROFILE).accepted,
  });

  const result = await service.acceptAgreements({
    agreementAcceptance: {
      accepted: true,
      termsVersion: TEST_LEGAL_PROFILE.termsVersion,
      privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    },
  });

  assert.equal(result.agreementsAccepted, true);
  assert.match(captured.sql, /agreements_accepted_at = CASE .* THEN now\(\) ELSE agreements_accepted_at END/);
  assert.deepEqual(captured.params, [
    userId,
    TEST_LEGAL_PROFILE.termsVersion,
    TEST_LEGAL_PROFILE.privacyVersion,
    "session",
  ]);
});

test("login uses one primary flow with themed legal consent and no auth theme grid", () => {
  const template = read("inCircleClient/pages/login/index.wxml");
  const styles = read("inCircleClient/pages/login/index.wxss");
  const script = read("inCircleClient/pages/login/index.js");
  const accountTemplate = read("inCircleClient/pages/circle-switch/index.wxml");
  const accountScript = read("inCircleClient/pages/circle-switch/index.js");
  const app = JSON.parse(read("inCircleClient/app.json"));

  assert.ok(app.pages.includes("pages/legal/index"));
  assert.doesNotMatch(template, /mode-tabs|theme-picker|status-row|微信绑定校验/);
  assert.match(template, /class="step-rail"/);
  assert.match(template, /账号安全[\s\S]*圈内资料/);
  assert.match(template, /data-mode="forgot"/);
  assert.match(template, /data-mode="register"/);
  assert.match(template, /data-type="terms"[\s\S]*《用户服务协议》/);
  assert.match(template, /data-type="privacy"[\s\S]*《隐私政策》/);
  assert.match(template, /images\/ui-icons\/check\.svg/);
  assert.match(template, /disabled="\{\{avatarUploading \|\| submitting \|\| !agreementAccepted\}\}"/);
  assert.match(script, /if \(!this\.data\.agreementAccepted\)\s*\{\s*this\.requireAgreement\(\)/);
  assert.doesNotMatch(script, /wx\.getUserProfile|syncWechatProfile\(/);
  assert.match(script, /mode === "consent"[\s\S]*acceptAgreements/);
  assert.match(script, /loadLegalProfile\(options\)[\s\S]*getPublicLegalProfile/);
  assert.match(script, /acceptancePayload\(true, this\.data\.legalProfile\)/);
  assert.match(script, /if \(!agreementAccepted\)\s*\{[\s\S]*setAuthMode\("agreement"[\s\S]*return;[\s\S]*\}\s*this\.loadSession\(\)/);
  assert.match(script, /mode === "agreement"[\s\S]*markLocallyAccepted\(this\.data\.legalProfile\)[\s\S]*this\.loadSession\(\)/);
  assert.match(template, /同意前不会向后端校验微信身份/);

  assert.match(styles, /\.auth-head-icon\s*\{[^}]*background:\s*var\(--theme-soft/s);
  assert.match(styles, /\.accepted \.agreement-check\s*\{[^}]*background:\s*var\(--theme-primary/s);
  assert.match(styles, /\.accepted \.agreement-check image\s*\{[^}]*opacity:\s*1/s);
  assert.match(styles, /\.login-actions \.primary-btn\s*\{[^}]*background:\s*var\(--theme-primary/s);
  assert.match(styles, /\.brand-panel\s*\{[^}]*linear-gradient\([^}]*var\(--theme-primary/s);
  assert.match(styles, /\.circle-mark\s*\{[^}]*width:\s*72rpx;[^}]*height:\s*72rpx/s);
  assert.match(styles, /\.login-shell\s*\{[^}]*min-height:\s*calc\(100vh/s);
  assert.match(styles, /\.login-panel\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.agreement-check\s*\{[^}]*width:\s*32rpx;[^}]*height:\s*32rpx;[^}]*flex:\s*0 0 32rpx;[^}]*box-sizing:\s*border-box/s);
  assert.match(styles, /\.agreement-row\s*\{[^}]*align-items:\s*center/s);
  assert.match(styles, /\.agreement-copy\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/s);
  assert.match(styles, /\.login-page\s*\{[^}]*padding-bottom:\s*calc\(16rpx \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(script, /setAuthMode\(mode, options\)[\s\S]*agreementAccepted:\s*false/);
  assert.match(styles, /\.auth-secondary\s*\{[^}]*width:\s*100%;[^}]*margin-top:\s*auto/s);
  assert.match(template, /class="circle-mark[^\"]*"[^>]*>圈<\/view>/);
  assert.match(template, /class="auth-secondary"[\s\S]*创建账号/);
  assert.match(accountTemplate, /data-type="terms"[^>]*bindtap="openLegal">用户服务协议/);
  assert.match(accountTemplate, /data-type="privacy"[^>]*bindtap="openLegal">隐私政策/);
  assert.match(accountScript, /openLegal\(e\)[\s\S]*pages\/legal\/index\?type=/);
  assert.doesNotMatch(styles, /position:\s*fixed[^}]*login-panel/s);
});

test("public legal profile is stored in PostgreSQL and read without authentication", async () => {
  const migration = read("server/db/migrations/0023_public_legal_profile.sql");
  const versionMigration = read("server/db/migrations/0024_public_legal_versions.sql");
  const schema = read("server/db/schema.sql");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");
  const profileSource = read("server/src/legal-profile.js");
  const migrateSource = read("server/src/migrate.js");
  const clientSource = read("inCircleClient/utils/legal.js");
  const compose = read("server/docker-compose.yml");
  const deployExample = read("scripts/deploy-server.example.ps1");

  [migration, schema].forEach((sql) => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_public_legal_profile/);
    assert.match(sql, /operator_name text NOT NULL DEFAULT ''/);
    assert.match(sql, /contact_email text NOT NULL DEFAULT ''/);
    assert.match(sql, /CHECK \(singleton_id = 1\)/);
  });
  [versionMigration, schema].forEach((sql) => {
    assert.match(sql, /terms_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /privacy_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /effective_date date/);
  });
  assert.match(routes, /case "incirclePublicLegalProfile"[\s\S]*service\.publicLegalProfile\(\)/);
  assert.match(api, /const ANONYMOUS_TYPES\s*=\s*\{[\s\S]*incirclePublicLegalProfile:\s*true/);
  assert.match(api, /const loginCodePromise = anonymous[\s\S]*Promise\.resolve\(""\)/);
  assert.match(api, /function getPublicLegalProfile\(options\)/);
  assert.doesNotMatch(clientSource, /const (?:OPERATOR_NAME|CONTACT_EMAIL|TERMS_VERSION|PRIVACY_VERSION|EFFECTIVE_DATE)\s*=/);
  assert.match(migrateSource, /config\.nodeEnv === "production" && !legalProfile\.configured/);
  assert.match(deployExample, /incirclePublicLegalProfile/);
  [
    "LEGAL_OPERATOR_NAME",
    "LEGAL_CONTACT_EMAIL",
    "LEGAL_TERMS_VERSION",
    "LEGAL_PRIVACY_VERSION",
    "LEGAL_EFFECTIVE_DATE",
  ].forEach((name) => {
    assert.ok(compose.includes(name + ": ${" + name + ":-}"));
  });

  const parsedEffectiveDate = pgTypes.getTypeParser(pgTypes.builtins.DATE)(
    TEST_LEGAL_PROFILE.effectiveDate
  );
  assert.ok(parsedEffectiveDate instanceof Date);
  const storedRow = {
    operator_name: "测试运营者",
    contact_email: "legal@example.test",
    terms_version: TEST_LEGAL_PROFILE.termsVersion,
    privacy_version: TEST_LEGAL_PROFILE.privacyVersion,
    effective_date: parsedEffectiveDate,
    updated_at: "2099-01-02T00:00:00.000Z",
  };
  const db = {
    async query(sql, params) {
      if (/INSERT INTO incircle_public_legal_profile/.test(sql)) {
        assert.deepEqual(params, [
          TEST_LEGAL_PROFILE.operatorName,
          TEST_LEGAL_PROFILE.contactEmail,
          TEST_LEGAL_PROFILE.termsVersion,
          TEST_LEGAL_PROFILE.privacyVersion,
          TEST_LEGAL_PROFILE.effectiveDate,
        ]);
      }
      return { rows: [storedRow] };
    },
  };
  const reconciled = await reconcilePublicLegalProfile(db, {
    legalOperatorName: TEST_LEGAL_PROFILE.operatorName,
    legalContactEmail: TEST_LEGAL_PROFILE.contactEmail,
    legalTermsVersion: TEST_LEGAL_PROFILE.termsVersion,
    legalPrivacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    legalEffectiveDate: TEST_LEGAL_PROFILE.effectiveDate,
  });
  assert.equal(reconciled.configured, true);
  assert.equal(reconciled.profile.effectiveDate, TEST_LEGAL_PROFILE.effectiveDate);
  assert.deepEqual(await readPublicLegalProfile(db), {
    operatorName: "测试运营者",
    contactEmail: "legal@example.test",
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    effectiveDate: TEST_LEGAL_PROFILE.effectiveDate,
    updatedAt: storedRow.updated_at,
  });
  assert.match(profileSource, /PUBLIC_LEGAL_PROFILE_NOT_CONFIGURED/);
});

test("public legal profile client never requests a WeChat login code", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  let requestOptions = null;
  try {
    global.getApp = () => ({
      globalData: {
        backendMode: "http",
        useHttpBackend: true,
        httpBackendBaseUrl: "https://api.example.test",
        httpBackendTimeout: 2000,
        envVersion: "develop",
      },
    });
    global.wx = {
      getStorageSync() { return {}; },
      setStorageSync() {},
      removeStorageSync() {},
      login() { throw new Error("wx.login must not run for public legal data"); },
      request(options) {
        requestOptions = options;
        setImmediate(() => options.success({
          statusCode: 200,
          data: {
            success: true,
            data: TEST_LEGAL_PROFILE,
          },
        }));
        return { abort() {} };
      },
    };
    const apiPath = require.resolve("../../inCircleClient/utils/api");
    delete require.cache[apiPath];
    const clientApi = require(apiPath);
    const profile = await clientApi.getPublicLegalProfile();
    assert.equal(profile.operatorName, "测试运营者");
    assert.equal(requestOptions.data.type, "incirclePublicLegalProfile");
    assert.equal(Object.hasOwn(requestOptions.data, "wechatLoginCode"), false);
    assert.equal(Object.hasOwn(requestOptions.header, "Authorization"), false);
  } finally {
    global.wx = previousWx;
    global.getApp = previousGetApp;
  }
});

test("public legal documents hydrate database profile and match actual sensitive flows", () => {
  const legalTemplate = read("inCircleClient/pages/legal/index.wxml");
  const legalStyles = read("inCircleClient/pages/legal/index.wxss");
  const profile = TEST_LEGAL_PROFILE;
  const terms = clientLegal.getDocument("terms", profile);
  const privacy = clientLegal.getDocument("privacy", profile);
  const serialized = JSON.stringify({ terms, privacy });

  assert.match(terms.intro, /个人开发者测试运营者/);
  assert.match(serialized, /legal@example\.test/);
  assert.equal(terms.version, TEST_LEGAL_PROFILE.termsVersion);
  assert.equal(privacy.version, TEST_LEGAL_PROFILE.privacyVersion);
  assert.equal(terms.effectiveDate, "2099 年 1 月 2 日");
  assert.ok(terms.sections.length >= 10);
  assert.ok(privacy.sections.length >= 10);
  ["AA 功能仅用于记录", "微信 OpenID/UnionID", "位置", "AI 服务商", "账号注销", "不保存明文密码"].forEach((phrase) => {
    assert.match(serialized, new RegExp(phrase));
  });
  assert.match(legalTemplate, /document\.sections/);
  assert.match(legalTemplate, /copyContactEmail/);
  assert.match(legalTemplate, /legalLoading/);
  assert.match(legalTemplate, /retryLegalProfile/);
  assert.match(legalStyles, /\.legal-hero\s*\{[^}]*var\(--theme-primary-dark/s);
  assert.match(legalStyles, /\.legal-list-dot\s*\{[^}]*var\(--theme-primary/s);
});
