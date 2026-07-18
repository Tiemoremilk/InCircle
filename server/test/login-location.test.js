const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeLoginLocation,
  reverseGeocodeTencent,
} = require("../src/location");
const {
  clearAccountSessionLocations,
  listAccountSessions,
  updateCurrentAccountSessionLocation,
} = require("../src/account-sessions");
const { InCircleService } = require("../src/services/incircle");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("login locations accept precise GCJ-02 coordinates and reject invalid input", () => {
  assert.deepEqual(normalizeLoginLocation({
    latitude: 38.914003812,
    longitude: 121.614681288,
    accuracy: 8.26,
  }), {
    latitude: 38.9140038,
    longitude: 121.6146813,
    accuracy: 8.3,
  });
  assert.throws(
    () => normalizeLoginLocation({ latitude: 91, longitude: 121 }),
    (error) => error.errCode === "INVALID_LOGIN_LOCATION" && error.statusCode === 400
  );
  assert.throws(
    () => normalizeLoginLocation({ latitude: 38, longitude: "not-a-number" }),
    (error) => error.errCode === "INVALID_LOGIN_LOCATION"
  );
  assert.throws(
    () => normalizeLoginLocation({ latitude: 38, longitude: 121, accuracy: -1 }),
    (error) => error.errCode === "INVALID_LOGIN_LOCATION"
  );
});

test("reverse geocoding uses only the fixed Tencent endpoint and fails closed", async () => {
  let requestedUrl;
  const address = await reverseGeocodeTencent(
    { latitude: 38.9140038, longitude: 121.6146813 },
    "private-map-key",
    {
      fetchImpl: async (url) => {
        requestedUrl = new URL(String(url));
        return {
          ok: true,
          async json() {
            return {
              status: 0,
              result: {
                address: "辽宁省大连市沙河口区示例路 1 号",
                address_component: {
                  province: "辽宁省",
                  city: "大连市",
                  district: "沙河口区",
                },
              },
            };
          },
        };
      },
    }
  );
  assert.equal(requestedUrl.protocol, "https:");
  assert.equal(requestedUrl.hostname, "apis.map.qq.com");
  assert.equal(requestedUrl.pathname, "/ws/geocoder/v1/");
  assert.equal(requestedUrl.searchParams.get("location"), "38.9140038,121.6146813");
  assert.equal(requestedUrl.searchParams.get("key"), "private-map-key");
  assert.deepEqual(address, {
    province: "辽宁省",
    city: "大连市",
    district: "沙河口区",
    detail: "辽宁省大连市沙河口区示例路 1 号",
    resolved: true,
  });

  let called = false;
  const withoutKey = await reverseGeocodeTencent(
    { latitude: 38, longitude: 121 },
    "",
    { fetchImpl: async () => { called = true; } }
  );
  assert.equal(called, false);
  assert.equal(withoutKey.resolved, false);

  const failed = await reverseGeocodeTencent(
    { latitude: 38, longitude: 121 },
    "private-map-key",
    { fetchImpl: async () => { throw new Error("network unavailable"); } }
  );
  assert.equal(failed.resolved, false);
});

test("precise locations are scoped to the current device session and can be cleared", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const queries = [];
  const locationRow = {
    id: sessionId,
    user_id: userId,
    token_version: 1,
    device_name: "Example Phone",
    login_address: "198.51.100.8",
    login_location_source: "wx.getLocation",
    login_latitude: 38.9140038,
    login_longitude: 121.6146813,
    login_accuracy_m: 8.3,
    login_location_province: "辽宁省",
    login_location_city: "大连市",
    login_location_district: "沙河口区",
    login_location_detail: "辽宁省大连市沙河口区示例路 1 号",
    login_location_captured_at: new Date(),
    last_login_at: new Date(),
    expires_at: new Date(Date.now() + 60000),
    revoked_at: null,
  };
  const updateDb = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [locationRow], rowCount: 1 };
    },
  };
  await updateCurrentAccountSessionLocation(updateDb, userId, sessionId, {
    source: "wx.getLocation",
    latitude: 38.9140038,
    longitude: 121.6146813,
    accuracy: 8.3,
    province: "辽宁省",
    city: "大连市",
    district: "沙河口区",
    detail: "辽宁省大连市沙河口区示例路 1 号",
  });
  assert.match(queries[0].sql, /WHERE id = \$1[\s\S]*AND user_id = \$2/);
  assert.deepEqual(queries[0].params.slice(0, 6), [
    sessionId,
    userId,
    "wx.getLocation",
    38.9140038,
    121.6146813,
    8.3,
  ]);

  await clearAccountSessionLocations(updateDb, userId);
  assert.match(queries[1].sql, /login_latitude = NULL/);
  assert.deepEqual(queries[1].params, [userId]);

  let listQuery = 0;
  const sessions = await listAccountSessions({
    async query() {
      listQuery += 1;
      if (listQuery === 1) return { rows: [], rowCount: 0 };
      return { rows: [locationRow], rowCount: 1 };
    },
  }, userId, sessionId);
  assert.equal(sessions[0].loginLocation.available, true);
  assert.equal(sessions[0].loginLocation.city, "大连市");
  assert.equal(sessions[0].loginLocation.latitude, 38.9140038);
  assert.equal(Object.hasOwn(sessions[0], "device_key_hash"), false);
});

test("Mini Program login location is optional, themed, disclosed, and wired end to end", async () => {
  const locationMigration = read("server/db/migrations/0034_precise_login_location.sql");
  const optInMigration = read("server/db/migrations/0035_login_location_explicit_opt_in.sql");
  const schema = read("server/db/schema.sql");
  const service = read("server/src/services/incircle.js");
  const routes = read("server/src/routes/incircle.js");
  const server = read("server/src/server.js");
  const locationService = read("server/src/location.js");
  const compose = read("server/docker-compose.yml");
  const envExample = read("server/.env.example");
  const deployExample = read("scripts/deploy-server.example.ps1");
  const clientApi = read("inCircleClient/utils/api.js");
  const login = read("inCircleClient/pages/login/index.js");
  const clientLocation = read("inCircleClient/utils/login-location.js");
  const privateApi = read("inCircleClient/utils/wechat-private-api.js");
  const accountPage = read("inCircleClient/pages/account-settings/index.wxml");
  const accountScript = read("inCircleClient/pages/account-settings/index.js");
  const accountStyles = read("inCircleClient/pages/account-settings/index.wxss");
  const circleSettingsScript = read("inCircleClient/pages/circle-settings/index.js");
  const dialogUtility = read("inCircleClient/utils/dialog.js");
  const dialogComponent = read("inCircleClient/components/theme-dialog/index.js");
  const dialogTemplate = read("inCircleClient/components/theme-dialog/index.wxml");
  const privacy = read("inCircleClient/utils/legal.js");
  const activities = read("inCircleClient/pages/activities/index.js");
  const tools = read("inCircleClient/pages/tools/index.js");
  const app = JSON.parse(read("inCircleClient/app.json"));

  [locationMigration, schema].forEach((sql) => {
    assert.match(sql, /login_latitude double precision/);
    assert.match(sql, /login_location_captured_at timestamptz/);
    assert.match(sql, /idx_incircle_account_sessions_location_retention/);
  });
  assert.match(locationMigration, /terms_version = '2026-07-18'/);
  assert.match(locationMigration, /privacy_version = '2026-07-18'/);
  assert.match(schema, /precise_login_location_enabled boolean NOT NULL DEFAULT false/);
  assert.match(optInMigration, /ALTER COLUMN precise_login_location_enabled SET DEFAULT false/);
  assert.match(optInMigration, /SET precise_login_location_enabled = false/);
  assert.match(optInMigration, /login_location_captured_at = NULL/);
  assert.match(routes, /incircleEnablePreciseLoginLocation/);
  assert.match(routes, /incircleUpdatePreciseLoginLocationPreference/);
  assert.match(routes, /incircleUpdateCurrentLoginLocation/);
  assert.match(service, /async enablePreciseLoginLocation\(body\)/);
  assert.match(service, /SELECT precise_login_location_enabled[\s\S]*FOR UPDATE/);
  assert.match(service, /LOGIN_LOCATION_INITIAL_CAPTURE_REQUIRED/);
  assert.match(service, /async updatePreciseLoginLocationPreference\(body\)/);
  assert.match(service, /async updateCurrentLoginLocation\(body\)/);
  assert.match(service, /addressResolved: location\.resolved === true/);
  assert.doesNotMatch(service, /logOperation[^\n]*latitude|logOperation[^\n]*longitude/);
  assert.match(server, /LOGIN_LOCATION_CLEANUP_INTERVAL_MS/);
  assert.match(locationService, /https:\/\/apis\.map\.qq\.com\/ws\/geocoder\/v1\//);
  assert.match(compose, /TENCENT_MAP_KEY: \$\{TENCENT_MAP_KEY:-\}/);
  assert.match(envExample, /^TENCENT_MAP_KEY=$/m);
  assert.match(deployExample, /\[string\]\$TencentMapKey = ""/);
  assert.doesNotMatch(deployExample, /TENCENT_MAP_KEY=[^$\r\n][^\r\n]+/);

  assert.ok(app.requiredPrivateInfos.includes("getLocation"));
  assert.match(app.permission["scope.userLocation"].desc, /授权.*登录位置/);
  assert.ok(app.permission["scope.userLocation"].desc.length <= 30);
  assert.match(clientApi, /enablePreciseLoginLocation/);
  assert.match(clientApi, /updateCurrentLoginLocation/);
  assert.match(clientLocation, /wx\.getSetting/);
  assert.match(clientLocation, /wx\.getPrivacySetting/);
  assert.doesNotMatch(clientLocation, /wx\.authorize/);
  assert.doesNotMatch(clientLocation, /LOCATION_TIMEOUT_MS|activeCapture|setTimeout/);
  assert.doesNotMatch(clientLocation, /requirePrivacyAuthorize/);
  assert.match(clientLocation, /if \(interactive\) return captureReadyLocation\(enablePreference\)/);
  assert.match(privateApi, /PRIVACY_DENIED_CODES[\s\S]*privacy-config-error/);
  assert.match(login, /loginLocation\.captureAndSave\(session, \{ interactive: false \}\)/);
  assert.match(accountPage, /记录精确登录位置/);
  assert.match(accountPage, /locate-fixed\.svg/);
  assert.match(accountPage, /登录位置/);
  assert.match(accountPage, /网络出口/);
  assert.match(accountStyles, /\.session-location-mark\s*\{[^}]*var\(--theme-soft/s);
  assert.match(accountPage, /class="location-permission-sheet"/);
  assert.match(accountPage, /open-type="openSetting"[^>]*bindopensetting="onLocationSettingResult"/);
  assert.match(accountPage, /bindtap="onOpenAppLocationSetting"/);
  assert.match(accountScript, /onLocationSettingResult\(e\)[\s\S]*authSetting\["scope\.userLocation"\]/);
  assert.match(accountScript, /wx\.openAppAuthorizeSetting/);
  assert.match(accountScript, /beginInteractiveLocation\(enablePreference\)/);
  assert.match(accountScript, /enablePreference:\s*enabling/);
  assert.doesNotMatch(accountScript, /wx\.openSetting/);
  assert.match(accountStyles, /\.location-permission-button\.confirm\s*\{[^}]*var\(--theme-primary/s);
  assert.match(accountStyles, /\.location-permission-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(accountStyles, /\.location-permission-button\s*\{[^}]*flex:\s*1 1 0[^}]*width:\s*0/s);
  assert.match(accountStyles, /\.location-permission-action-spacer\s*\{[^}]*flex:\s*0 0 16rpx/s);
  assert.match(accountStyles, /\.location-permission-button\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(dialogUtility, /confirmOpenType:\s*source\.confirmOpenType/);
  assert.match(dialogComponent, /onConfirmOpenSetting\(e\)/);
  assert.match(dialogTemplate, /open-type="openSetting"/);
  assert.match(dialogTemplate, /bindopensetting="onConfirmOpenSetting"/);
  assert.match(circleSettingsScript, /title:\s*"需要相册权限"[\s\S]*confirmOpenType:\s*"openSetting"/);
  [activities, tools].forEach((script) => {
    assert.match(script, /wechat-private-api/);
    assert.match(script, /classifyPrivacyFailure/);
  });
  [
    "wx.getLocation",
    "GCJ-02",
    "腾讯位置服务",
    "敏感个人信息",
    "不持续定位",
    "不会影响账号登录",
    "最多保留 90 天",
    "立即清除",
    "不能单独作为",
  ].forEach((phrase) => assert.match(privacy, new RegExp(phrase)));
});

test("explicit location enablement locks the user and stores preference and location atomically", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const queries = [];
  const logs = [];
  let transactions = 0;
  const sessionRow = {
    id: sessionId,
    user_id: userId,
    device_name: "Example Phone",
    login_location_source: "wx.getLocation",
    login_latitude: 38.914,
    login_longitude: 121.615,
    login_accuracy_m: 9.4,
    login_location_province: "",
    login_location_city: "",
    login_location_district: "",
    login_location_detail: "",
    login_location_captured_at: new Date(),
    last_login_at: new Date(),
    expires_at: new Date(Date.now() + 60000),
    created_at: new Date(),
    revoked_at: null,
  };
  const db = {
    async withTransaction(callback) {
      transactions += 1;
      return callback();
    },
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ text, params });
      if (/SELECT precise_login_location_enabled/.test(text)) {
        return { rows: [{ precise_login_location_enabled: false }] };
      }
      if (/SET login_location_source = \$3/.test(text)) return { rows: [sessionRow], rowCount: 1 };
      if (/count\(\*\) OVER/.test(text)) {
        return {
          rows: [{
            ...sessionRow,
            session_total: 1,
            active_session_count: 1,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const service = new InCircleService({ db, config: { tencentMapKey: "" } }, {});
  service.requireUser = async () => ({
    user: { id: userId, nickname: "Example", precise_login_location_enabled: false },
    identity: { openid: "example-openid", sessionId },
  });
  service.enforceAuthRateLimit = () => {};
  service.logOperation = async (...args) => { logs.push(args); };

  const result = await service.enablePreciseLoginLocation({
    location: { latitude: 38.914, longitude: 121.615, accuracy: 9.4 },
  });
  assert.equal(transactions, 1);
  assert.equal(result.updated, true);
  assert.equal(result.preciseLoginLocationEnabled, true);
  assert.equal(result.sessions[0].loginLocation.available, true);
  const lockIndex = queries.findIndex((item) => /FOR UPDATE$/.test(item.text));
  const preferenceIndex = queries.findIndex((item) => /SET precise_login_location_enabled = true/.test(item.text));
  const locationIndex = queries.findIndex((item) => /SET login_location_source = \$3/.test(item.text));
  assert.ok(lockIndex >= 0 && preferenceIndex > lockIndex && locationIndex > preferenceIndex);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2], "开启精确登录定位");
  assert.deepEqual(logs[0][5], { addressResolved: false });
  assert.doesNotMatch(JSON.stringify(logs), /38\.914|121\.615/);
});

test("the legacy preference endpoint cannot enable location without an initial capture", async () => {
  const service = new InCircleService({
    config: {},
    db: { withTransaction() { throw new Error("transaction must not start"); } },
  }, {});
  service.requireUser = async () => ({
    user: { id: "11111111-1111-4111-8111-111111111111", precise_login_location_enabled: false },
    identity: { sessionId: "22222222-2222-4222-8222-222222222222" },
  });
  await assert.rejects(
    () => service.updatePreciseLoginLocationPreference({ enabled: true }),
    (error) => error.errCode === "LOGIN_LOCATION_INITIAL_CAPTURE_REQUIRED" && error.statusCode === 409
  );
});

test("interactive location calls the real API directly and classifies every permission layer", async () => {
  const clientApiPath = require.resolve("../../inCircleClient/utils/api");
  const clientLocationPath = require.resolve("../../inCircleClient/utils/login-location");
  const previousWx = global.wx;
  const clientApi = require(clientApiPath);
  const originalEnable = clientApi.enablePreciseLoginLocation;
  const originalUpdate = clientApi.updateCurrentLoginLocation;
  const uploads = [];
  try {
    clientApi.enablePreciseLoginLocation = async (location) => {
      uploads.push({ type: "enable", location });
      return {
        updated: true,
        preciseLoginLocationEnabled: true,
        addressResolved: true,
        sessions: [],
      };
    };
    clientApi.updateCurrentLoginLocation = async (location) => {
      uploads.push({ type: "update", location });
      return { updated: true, addressResolved: true };
    };
    let requestedOptions;
    global.wx = {
      getSetting() { throw new Error("interactive success must not preflight scope"); },
      getPrivacySetting() { throw new Error("interactive success must use the official popup"); },
      getLocation(options) {
        requestedOptions = options;
        options.success({ latitude: 38.914, longitude: 121.615, accuracy: 9.4 });
      },
    };
    delete require.cache[clientLocationPath];
    const clientLocation = require(clientLocationPath);
    const capturedPromise = clientLocation.captureAndSave(
      { user: { preciseLoginLocationEnabled: false } },
      { interactive: true, enablePreference: true }
    );
    assert.ok(requestedOptions, "wx.getLocation must start in the user interaction call stack");
    const captured = await capturedPromise;
    assert.equal(captured.updated, true);
    assert.equal(requestedOptions.type, "gcj02");
    assert.equal(requestedOptions.isHighAccuracy, true);
    assert.equal(requestedOptions.highAccuracyExpireTime, 5000);
    assert.deepEqual(uploads[0], {
      type: "enable",
      location: { latitude: 38.914, longitude: 121.615, accuracy: 9.4 },
    });

    const failure = async (error, authorization, environment) => {
      global.wx = {
        getLocation(options) { options.fail(error); },
        getSetting(options) {
          options.success({ authSetting: { "scope.userLocation": authorization } });
        },
        getSystemSetting() {
          return { locationEnabled: !environment || environment.system !== false };
        },
        getAppAuthorizeSetting() {
          return { locationAuthorized: (environment && environment.app) || "authorized" };
        },
      };
      return clientLocation.captureAndSave(
        { user: { preciseLoginLocationEnabled: false } },
        { interactive: true, enablePreference: true }
      );
    };
    assert.equal((await failure({ errno: 104, errMsg: "getLocation:fail privacy permission is not authorized" })).reason, "privacy-denied");
    assert.equal((await failure({ errno: 112, errMsg: "getLocation:fail api scope is not declared in the privacy agreement" })).reason, "privacy-config-error");
    assert.equal((await failure({ errMsg: "getLocation:fail auth deny" }, false)).reason, "permission-denied");
    assert.equal((await failure({ errMsg: "getLocation:fail system deny" }, true, { app: "denied" })).reason, "app-permission-denied");
    assert.equal((await failure({ errMsg: "getLocation:fail system disabled" }, true, { system: false })).reason, "system-location-disabled");
  } finally {
    clientApi.enablePreciseLoginLocation = originalEnable;
    clientApi.updateCurrentLoginLocation = originalUpdate;
    delete require.cache[clientLocationPath];
    global.wx = previousWx;
  }
});

test("silent login location never opens privacy or scope authorization", async () => {
  const clientApiPath = require.resolve("../../inCircleClient/utils/api");
  const clientLocationPath = require.resolve("../../inCircleClient/utils/login-location");
  const previousWx = global.wx;
  const clientApi = require(clientApiPath);
  const originalUpdate = clientApi.updateCurrentLoginLocation;
  let locationCalls = 0;
  let uploads = 0;
  try {
    clientApi.updateCurrentLoginLocation = async () => {
      uploads += 1;
      return { updated: true, addressResolved: false };
    };
    global.wx = {
      getPrivacySetting(options) { options.success({ needAuthorization: true }); },
      getSetting(options) { options.success({ authSetting: { "scope.userLocation": true } }); },
      getLocation() { locationCalls += 1; },
    };
    delete require.cache[clientLocationPath];
    const clientLocation = require(clientLocationPath);
    const skipped = await clientLocation.captureAndSave(
      { user: { preciseLoginLocationEnabled: true } },
      { interactive: false }
    );
    assert.equal(skipped.reason, "privacy-authorization-required");
    assert.equal(locationCalls, 0);
    assert.equal(uploads, 0);

    global.wx.getPrivacySetting = (options) => options.success({ needAuthorization: false });
    global.wx.getSystemSetting = () => ({ locationEnabled: true });
    global.wx.getAppAuthorizeSetting = () => ({ locationAuthorized: "authorized" });
    global.wx.getLocation = (options) => {
      locationCalls += 1;
      options.success({ latitude: 38.9, longitude: 121.6, accuracy: 12 });
    };
    const captured = await clientLocation.captureAndSave(
      { user: { preciseLoginLocationEnabled: true } },
      { interactive: false }
    );
    assert.equal(captured.updated, true);
    assert.equal(locationCalls, 1);
    assert.equal(uploads, 1);
  } finally {
    clientApi.updateCurrentLoginLocation = originalUpdate;
    delete require.cache[clientLocationPath];
    global.wx = previousWx;
  }
});
