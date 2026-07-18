const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { types: pgTypes } = require("pg");

const ROOT = path.resolve(__dirname, "../..");
const serverLegal = require("../src/legal");
const { recordAgreementAcceptance } = require("../src/agreement-store");
const { validateConfig } = require("../src/config");
const { readPublicLegalProfile, reconcilePublicLegalProfile } = require("../src/legal-profile");
const { InCircleService } = require("../src/services/incircle");
const clientLegal = require("../../inCircleClient/utils/legal");

const TEST_LEGAL_PROFILE = {
  operatorType: "individual",
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
  const current = {
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    acceptedAt: new Date().toISOString(),
  };
  assert.equal(serverLegal.agreementStatus({ id: "user" }, TEST_LEGAL_PROFILE, {
    current,
    latest: current,
  }).accepted, true);
  assert.deepEqual(serverLegal.agreementStatus({ id: "legacy" }, TEST_LEGAL_PROFILE, {
    current: null,
    latest: null,
  }), {
    accepted: false,
    required: true,
    reason: "missing",
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    acceptedTermsVersion: "",
    acceptedPrivacyVersion: "",
    changedDocuments: [],
    acceptedAt: null,
    lastAcceptedAt: null,
  });
  const updated = serverLegal.agreementStatus({ id: "user" }, TEST_LEGAL_PROFILE, {
    current: null,
    latest: { termsVersion: "old-terms", privacyVersion: "old-privacy", acceptedAt: "earlier" },
  });
  assert.equal(updated.reason, "updated");
  assert.deepEqual(updated.changedDocuments, ["terms", "privacy"]);
});

test("agreement consent is versioned in schema and every authentication path", () => {
  const migration = read("server/db/migrations/0022_account_agreements.sql");
  const consentMigration = read("server/db/migrations/0025_legal_consent_and_operator_type.sql");
  const schema = read("server/db/schema.sql");
  const service = read("server/src/services/incircle.js");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");
  const auth = read("inCircleClient/utils/auth.js");
  const mediaRoute = read("server/src/routes/media.js");

  [migration, schema].forEach((sql) => {
    assert.match(sql, /terms_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /privacy_version text NOT NULL DEFAULT ''/);
    assert.match(sql, /agreements_accepted_at timestamptz/);
    assert.match(sql, /agreement_acceptance_source text NOT NULL DEFAULT ''/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_account_agreement_acceptances/);
    assert.doesNotMatch(sql, /user_agent|ip_address|device_fingerprint/);
  });
  [consentMigration, schema].forEach((sql) => {
    assert.match(sql, /agreement_subject_id uuid/);
    assert.match(sql, /subject_id uuid/);
    assert.match(sql, /uq_incircle_users_agreement_subject_id/);
    assert.match(sql, /UNIQUE \(subject_id, terms_version, privacy_version\)/);
    assert.match(sql, /ON DELETE SET NULL/);
    assert.doesNotMatch(sql, /user_agent|ip_address|device_fingerprint/);
  });
  assert.match(consentMigration, /DROP TRIGGER IF EXISTS trg_incircle_users_record_agreement_acceptance/);
  assert.doesNotMatch(schema, /CREATE TRIGGER trg_incircle_users_record_agreement_acceptance/);
  ["register", "login", "bind", "reset"].forEach((source) => {
    assert.match(service, new RegExp(`requireAgreementAcceptance\\(body, "${source}", await this\\.currentLegalProfile\\(\\)\\)`));
  });
  assert.match(service, /async acceptAgreements\(body\)[\s\S]*requireAgreementAcceptance\(body, "session", await this\.currentLegalProfile\(\)\)/);
  assert.match(service, /recordAgreementAcceptance\(this\.db/);
  assert.match(service, /allowPendingAgreement/);
  assert.match(service, /agreementsAccepted:\s*agreements\.accepted/);
  assert.match(routes, /case "incircleAcceptAgreements"/);
  assert.match(api, /function acceptAgreements\(agreementAcceptance\)/);
  assert.match(api, /incircleAcceptAgreements:\s*\["incircleSession"\]/);
  assert.match(api, /auth\.handleAgreementRequired\(error\)/);
  assert.match(api, /AI 请求失败[\s\S]*auth\.handleAgreementRequired\(error\)/);
  assert.match(auth, /wx\.reLaunch\([\s\S]*pages\/agreement-consent\/index/);
  assert.match(mediaRoute, /AGREEMENT_ACCEPTANCE_REQUIRED/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS subject_id uuid;[\s\S]*idx_incircle_account_acceptances_subject_time/);
});

test("an authenticated legacy account records one immutable acceptance per version pair", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const subjectId = "22222222-2222-4222-8222-222222222222";
  const acceptedAt = "2099-01-02T03:04:05.000Z";
  let acceptance = null;
  let insertAttempts = 0;
  const user = { id: userId, agreement_subject_id: subjectId };
  const db = {
    withTransaction(callback) { return callback(); },
    async query(sql, params) {
      const statement = String(sql);
      if (/SELECT id, agreement_subject_id FROM incircle_users/.test(statement)) return { rows: [user] };
      if (/INSERT INTO incircle_account_agreement_acceptances/.test(statement)) {
        insertAttempts += 1;
        if (acceptance) return { rows: [] };
        acceptance = {
          id: "33333333-3333-4333-8333-333333333333",
          subject_id: subjectId,
          terms_version: params[2],
          privacy_version: params[3],
          acceptance_source: params[4],
          accepted_at: acceptedAt,
        };
        return { rows: [acceptance] };
      }
      if (/FROM incircle_account_agreement_acceptances/.test(statement)) return { rows: [acceptance] };
      if (/UPDATE incircle_users SET/.test(statement)) {
        return { rows: [{
          ...user,
          terms_version: params[1],
          privacy_version: params[2],
          agreements_accepted_at: params[3],
          agreement_acceptance_source: params[4],
        }] };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  const agreement = {
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    source: "session",
  };
  const first = await recordAgreementAcceptance(db, userId, agreement);
  const second = await recordAgreementAcceptance(db, userId, agreement);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.acceptance.acceptedAt, acceptedAt);
  assert.equal(second.acceptance.acceptedAt, acceptedAt);
  assert.equal(insertAttempts, 2);
});

test("authenticated business access is blocked until the current acceptance exists", async () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    openid: "openid-1",
    status: "active",
    logged_in: true,
    account_key: "account",
    password_hash: "hash",
    password_salt: "salt",
    auth_version: 3,
    agreement_subject_id: "22222222-2222-4222-8222-222222222222",
  };
  const service = new InCircleService({
    config: {},
    db: {
      async query(sql) {
        if (/FROM incircle_account_sessions/.test(String(sql))) {
          return { rows: [{
            id: "44444444-4444-4444-8444-444444444444",
            user_id: user.id,
            token_version: 1,
            expires_at: "2099-01-01T00:00:00.000Z",
            revoked_at: null,
          }] };
        }
        if (/incircle_account_agreement_acceptances/.test(String(sql))) {
          return { rows: [{
            acceptance_kind: "latest",
            id: "33333333-3333-4333-8333-333333333333",
            subject_id: user.agreement_subject_id,
            terms_version: "old-terms",
            privacy_version: "old-privacy",
            acceptance_source: "login",
            accepted_at: "2098-01-01T00:00:00.000Z",
          }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  }, {});
  service.resolveIdentity = async () => ({
    source: "token",
    openid: user.openid,
    userId: user.id,
    authVersion: 3,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionVersion: 1,
  });
  service.getUserById = async () => user;
  service.currentLegalProfile = async () => TEST_LEGAL_PROFILE;

  await assert.rejects(
    () => service.requireUser({}),
    (error) => error.statusCode === 428
      && error.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED"
      && error.details.reason === "updated"
  );
  const allowed = await service.requireUser({}, { allowPendingAgreement: true });
  assert.equal(allowed.user.id, user.id);
});

test("login uses one primary flow with themed legal consent and no auth theme grid", () => {
  const template = read("inCircleClient/pages/login/index.wxml");
  const styles = read("inCircleClient/pages/login/index.wxss");
  const script = read("inCircleClient/pages/login/index.js");
  const consentTemplate = read("inCircleClient/pages/agreement-consent/index.wxml");
  const consentStyles = read("inCircleClient/pages/agreement-consent/index.wxss");
  const consentScript = read("inCircleClient/pages/agreement-consent/index.js");
  const accountTemplate = read("inCircleClient/pages/account-settings/index.wxml");
  const accountScript = read("inCircleClient/pages/account-settings/index.js");
  const app = JSON.parse(read("inCircleClient/app.json"));

  assert.ok(app.pages.includes("pages/legal/index"));
  assert.ok(app.pages.includes("pages/agreement-consent/index"));
  assert.ok(app.pages.includes("pages/account-settings/index"));
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
  assert.match(script, /loadLegalProfile\(options\)[\s\S]*getPublicLegalProfile/);
  assert.match(script, /acceptancePayload\(true, this\.data\.legalProfile\)/);
  assert.match(script, /if \(auth\.getAccessToken\(\)\) return this\.loadSession\(\)/);
  assert.match(script, /if \(!session\.agreementsAccepted\)[\s\S]*openAgreementConsent\(\)/);
  assert.doesNotMatch(script, /isLocallyAccepted|markLocallyAccepted|setAuthMode\("agreement"|mode === "consent"/);
  assert.doesNotMatch(template, /先授权，再连接|同意前不会向后端校验微信身份|你的数据仍在原处/);
  assert.match(consentTemplate, /协议已更新|请确认以下协议|暂不同意并退出账号/);
  assert.match(consentTemplate, /disabled="\{\{!accepted \|\| submitting \|\| leaving\}\}"/);
  assert.match(consentTemplate, /!loading && !loadError/);
  assert.match(consentTemplate, /consent-action-error[\s\S]*actionError/);
  assert.match(consentScript, /api\.acceptAgreements/);
  assert.match(consentScript, /api\.logout\(\)/);
  assert.match(consentScript, /reason === "updated"/);
  assert.match(consentScript, /有更新/);
  assert.match(consentScript, /待确认/);
  assert.match(consentScript, /已确认/);
  assert.doesNotMatch(consentScript, /"一并确认"|"有新版本"/);
  assert.match(consentScript, /baseStatus:[\s\S]*!needsConfirmation/);
  assert.match(consentScript, /onShow\(\)[\s\S]*this\.data\.loadError \|\| this\.data\.actionError[\s\S]*this\.loadData\(\)/);
  assert.match(consentScript, /loadError:[\s\S]*actionError:/);
  assert.doesNotMatch(consentScript, /errorMessage/);
  assert.match(consentScript, /checked && baseStatus \? "已确认" : baseStatus/);
  assert.match(consentScript, /toggleDocument\(e\)[\s\S]*documents\.every\(\(item\) => item\.checked\)/);
  assert.match(consentScript, /toggleAccepted\(\)[\s\S]*withDocumentCheck\(item, accepted\)/);
  assert.match(consentTemplate, /document-icon-\{\{item\.type\}\}/);
  assert.match(consentScript, /images\/ui-icons\/file-text\.svg/);
  assert.match(consentScript, /images\/ui-icons\/fingerprint\.svg/);
  assert.match(consentTemplate, /document-status \{\{item\.statusState\}\}" wx:if="\{\{item\.status\}\}"/);
  assert.match(consentTemplate, /class="document-check-hit"[\s\S]*catchtap="toggleDocument"[\s\S]*class="document-check \{\{item\.checked \? 'checked' : ''\}\}"/);
  assert.match(consentTemplate, /images\/ui-icons\/check\.svg/);
  assert.match(consentScript, /theme\.applyPageTheme\(this\)/);
  assert.match(consentStyles, /var\(--theme-primary\)/);
  assert.match(consentStyles, /env\(safe-area-inset-bottom\)/);
  assert.match(consentTemplate, /class="consent-actions"[\s\S]*class="consent-button-grid"/);
  assert.match(consentTemplate, /退出账号不会删除圈子和历史数据/);
  assert.match(consentStyles, /\.consent-panel\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*flex-direction:\s*column/s);
  assert.match(consentStyles, /\.consent-actions\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(consentStyles, /\.consent-check\s*\{[^}]*height:\s*34rpx/s);
  assert.match(consentStyles, /\.consent-check-copy\s*\{[^}]*line-height:\s*34rpx/s);
  assert.match(consentStyles, /\.document-row::before\s*\{[^}]*background:\s*var\(--theme-primary\);[^}]*opacity:\s*0\.14/s);
  assert.match(consentStyles, /\.document-row\.checked::before\s*\{[^}]*opacity:\s*0\.07/s);
  assert.match(consentStyles, /\.document-row\.checked::after\s*\{[^}]*border:\s*1rpx solid var\(--theme-primary\);[^}]*opacity:\s*0\.1/s);
  assert.match(consentStyles, /\.consent-button-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.match(consentStyles, /\.consent-button-grid button\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center/s);

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
  assert.match(accountTemplate, /data-type="terms"[^>]*bindtap="openLegal"[\s\S]*?用户服务协议/);
  assert.match(accountTemplate, /data-type="privacy"[^>]*bindtap="openLegal"[\s\S]*?隐私政策/);
  assert.match(accountScript, /openLegal\(e\)[\s\S]*pages\/legal\/index\?type=/);
  assert.doesNotMatch(styles, /position:\s*fixed[^}]*login-panel/s);
});

test("public legal profile is stored in PostgreSQL and read without authentication", async () => {
  const migration = read("server/db/migrations/0023_public_legal_profile.sql");
  const versionMigration = read("server/db/migrations/0024_public_legal_versions.sql");
  const consentMigration = read("server/db/migrations/0025_legal_consent_and_operator_type.sql");
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
  [consentMigration, schema].forEach((sql) => {
    assert.match(sql, /operator_type/);
    assert.match(sql, /individual/);
    assert.match(sql, /enterprise/);
  });
  assert.match(routes, /case "incirclePublicLegalProfile"[\s\S]*service\.publicLegalProfile\(\)/);
  assert.match(api, /const ANONYMOUS_TYPES\s*=\s*\{[\s\S]*incirclePublicLegalProfile:\s*true/);
  assert.match(api, /const loginCodePromise = anonymous[\s\S]*Promise\.resolve\(""\)/);
  assert.match(api, /function getPublicLegalProfile\(options\)/);
  assert.doesNotMatch(clientSource, /const (?:OPERATOR_NAME|CONTACT_EMAIL|TERMS_VERSION|PRIVACY_VERSION|EFFECTIVE_DATE)\s*=/);
  assert.match(migrateSource, /config\.nodeEnv === "production" && !legalProfile\.configured/);
  assert.match(migrateSource, /initializeOperatorType = !applied\[OPERATOR_TYPE_MIGRATION_ID\]/);
  assert.match(deployExample, /incirclePublicLegalProfile/);
  assert.match(deployExample, /set_line HOST 0\.0\.0\.0/);
  assert.match(deployExample, /set_line PORT 3000/);
  assert.match(deployExample, /fill_empty_line LEGAL_OPERATOR_NAME/);
  assert.match(deployExample, /fill_empty_line LEGAL_TERMS_VERSION/);
  assert.doesNotMatch(deployExample, /set_line LEGAL_(?:OPERATOR|CONTACT|TERMS|PRIVACY|EFFECTIVE)/);
  [
    "LEGAL_OPERATOR_NAME",
    "LEGAL_CONTACT_EMAIL",
    "LEGAL_TERMS_VERSION",
    "LEGAL_PRIVACY_VERSION",
    "LEGAL_EFFECTIVE_DATE",
  ].forEach((name) => {
    assert.ok(compose.includes(name + ": ${" + name + ":-}"));
  });
  assert.ok(compose.includes("LEGAL_OPERATOR_TYPE: ${LEGAL_OPERATOR_TYPE:-individual}"));
  assert.ok(compose.includes('- "127.0.0.1:3000:3000"'));
  assert.doesNotMatch(compose, /- "3000:3000"/);

  const parsedEffectiveDate = pgTypes.getTypeParser(pgTypes.builtins.DATE)(
    TEST_LEGAL_PROFILE.effectiveDate
  );
  assert.ok(parsedEffectiveDate instanceof Date);
  const storedRow = {
    operator_type: "individual",
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
          TEST_LEGAL_PROFILE.operatorType,
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
    legalOperatorType: TEST_LEGAL_PROFILE.operatorType,
    legalOperatorName: TEST_LEGAL_PROFILE.operatorName,
    legalContactEmail: TEST_LEGAL_PROFILE.contactEmail,
    legalTermsVersion: TEST_LEGAL_PROFILE.termsVersion,
    legalPrivacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    legalEffectiveDate: TEST_LEGAL_PROFILE.effectiveDate,
  });
  assert.equal(reconciled.configured, true);
  assert.equal(reconciled.profile.effectiveDate, TEST_LEGAL_PROFILE.effectiveDate);
  assert.deepEqual(await readPublicLegalProfile(db), {
    operatorType: "individual",
    operatorName: "测试运营者",
    contactEmail: "legal@example.test",
    termsVersion: TEST_LEGAL_PROFILE.termsVersion,
    privacyVersion: TEST_LEGAL_PROFILE.privacyVersion,
    effectiveDate: TEST_LEGAL_PROFILE.effectiveDate,
    updatedAt: storedRow.updated_at,
  });
  assert.match(profileSource, /PUBLIC_LEGAL_PROFILE_NOT_CONFIGURED/);
});

test("operator type configuration rejects unsupported values before startup", () => {
  assert.throws(
    () => validateConfig({ nodeEnv: "development", legalOperatorType: "government" }),
    /LEGAL_OPERATOR_TYPE must be individual or enterprise/
  );
  assert.doesNotThrow(
    () => validateConfig({ nodeEnv: "development", legalOperatorType: "individual" })
  );
  assert.doesNotThrow(
    () => validateConfig({ nodeEnv: "development", legalOperatorType: "enterprise" })
  );
  assert.doesNotThrow(
    () => validateConfig({ nodeEnv: "development" })
  );
});

test("completed legal profile remains database-authoritative on later deploys", async () => {
  const storedRow = {
    operator_type: "individual",
    operator_name: "数据库主体",
    contact_email: "database@example.test",
    terms_version: "db-terms-v1",
    privacy_version: "db-privacy-v1",
    effective_date: "2098-02-03",
    updated_at: "2098-02-03T00:00:00.000Z",
  };
  let writes = 0;
  const db = {
    async query(sql) {
      if (/SELECT operator_type[\s\S]*FOR UPDATE/.test(sql)) return { rows: [storedRow] };
      writes += 1;
      throw new Error(`Unexpected legal profile write: ${sql}`);
    },
  };
  const result = await reconcilePublicLegalProfile(db, {
    legalOperatorType: "enterprise",
    legalOperatorName: "部署参数主体",
    legalContactEmail: "deploy@example.test",
    legalTermsVersion: "deploy-terms-v2",
    legalPrivacyVersion: "deploy-privacy-v2",
    legalEffectiveDate: "2099-03-04",
  });

  assert.equal(writes, 0);
  assert.equal(result.profile.operatorName, "数据库主体");
  assert.equal(result.profile.termsVersion, "db-terms-v1");
  assert.deepEqual(result.initializedFields, []);
});

test("empty legal profile is initialized once from deployment seed values", async () => {
  const emptyRow = {
    operator_type: "individual",
    operator_name: "",
    contact_email: "",
    terms_version: "",
    privacy_version: "",
    effective_date: null,
  };
  const initializedRow = {
    operator_type: "enterprise",
    operator_name: "首次主体",
    contact_email: "first@example.test",
    terms_version: "first-terms",
    privacy_version: "first-privacy",
    effective_date: "2099-04-05",
    updated_at: "2099-04-05T00:00:00.000Z",
  };
  let updateSql = "";
  let updateParams = null;
  const db = {
    async query(sql, params) {
      if (/SELECT operator_type[\s\S]*FOR UPDATE/.test(sql)) return { rows: [emptyRow] };
      if (/UPDATE incircle_public_legal_profile SET/.test(sql)) {
        updateSql = sql;
        updateParams = params;
        return { rows: [initializedRow] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const result = await reconcilePublicLegalProfile(db, {
    legalOperatorType: "enterprise",
    legalOperatorName: "首次主体",
    legalContactEmail: "first@example.test",
    legalTermsVersion: "first-terms",
    legalPrivacyVersion: "first-privacy",
    legalEffectiveDate: "2099-04-05",
  });

  ["operator_type", "operator_name", "contact_email", "terms_version", "privacy_version", "effective_date"].forEach(
    (column) => assert.match(updateSql, new RegExp(`${column} =`))
  );
  assert.deepEqual(updateParams, [
    "enterprise",
    "首次主体",
    "first@example.test",
    "first-terms",
    "first-privacy",
    "2099-04-05",
  ]);
  assert.equal(result.configured, true);
});

test("operator-type migration updates only its newly introduced field", async () => {
  const storedRow = {
    operator_type: "individual",
    operator_name: "保留主体",
    contact_email: "keep@example.test",
    terms_version: "keep-terms",
    privacy_version: "keep-privacy",
    effective_date: "2097-01-01",
  };
  let updateSql = "";
  let updateParams = null;
  const db = {
    async query(sql, params) {
      if (/SELECT operator_type[\s\S]*FOR UPDATE/.test(sql)) return { rows: [storedRow] };
      if (/UPDATE incircle_public_legal_profile SET/.test(sql)) {
        updateSql = sql;
        updateParams = params;
        return { rows: [{ ...storedRow, operator_type: "enterprise" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const result = await reconcilePublicLegalProfile(db, {
    legalOperatorType: "enterprise",
    legalOperatorName: "不能覆盖主体",
    legalContactEmail: "replace@example.test",
    legalTermsVersion: "replace-terms",
    legalPrivacyVersion: "replace-privacy",
    legalEffectiveDate: "2099-12-31",
  }, { initializeOperatorType: true });

  assert.match(updateSql, /operator_type = \$1/);
  assert.doesNotMatch(updateSql, /operator_name =|contact_email =|terms_version =|privacy_version =|effective_date =/);
  assert.deepEqual(updateParams, ["enterprise"]);
  assert.equal(result.profile.operatorName, "保留主体");
  assert.deepEqual(result.initializedFields, ["operatorType"]);
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

test("agreement-required navigation preserves the authenticated token", () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const globalData = {};
  let relaunchedTo = "";
  const authPath = require.resolve("../../inCircleClient/utils/auth");
  try {
    global.getApp = () => ({ globalData });
    global.getCurrentPages = () => [{ route: "pages/index/index" }];
    global.wx = {
      getStorageSync(key) { return storage[key] || ""; },
      setStorageSync(key, value) { storage[key] = value; },
      removeStorageSync(key) { delete storage[key]; },
      reLaunch(options) { relaunchedTo = options.url; },
    };
    delete require.cache[authPath];
    const clientAuth = require(authPath);
    clientAuth.setAccessToken("still-valid-token", "2099-01-01T00:00:00.000Z");

    assert.equal(clientAuth.handleAgreementRequired({
      errCode: "AGREEMENT_ACCEPTANCE_REQUIRED",
      details: { reason: "updated" },
    }), true);
    assert.equal(relaunchedTo, "/pages/agreement-consent/index");
    assert.equal(clientAuth.getAccessToken(), "still-valid-token");
    assert.deepEqual(globalData.pendingAgreementRequirement, { reason: "updated" });
  } finally {
    delete require.cache[authPath];
    global.wx = previousWx;
    global.getApp = previousGetApp;
    global.getCurrentPages = previousGetCurrentPages;
  }
});

test("public legal documents hydrate database profile and match actual sensitive flows", () => {
  const legalTemplate = read("inCircleClient/pages/legal/index.wxml");
  const legalStyles = read("inCircleClient/pages/legal/index.wxss");
  const profile = TEST_LEGAL_PROFILE;
  const terms = clientLegal.getDocument("terms", profile);
  const privacy = clientLegal.getDocument("privacy", profile);
  const serialized = JSON.stringify({ terms, privacy });

  assert.match(terms.intro, /个人开发者 测试运营者/);
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
  const enterpriseTerms = clientLegal.getDocument("terms", {
    ...profile,
    operatorType: "enterprise",
    operatorName: "测试企业",
  });
  assert.match(enterpriseTerms.intro, /企业开发者 测试企业/);
});
