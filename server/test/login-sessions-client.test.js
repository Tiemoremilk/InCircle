const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const clientRoot = path.resolve(__dirname, "../../inCircleClient");
const apiPath = path.join(clientRoot, "utils/api.js");
const authPath = path.join(clientRoot, "utils/auth.js");
const dialogPath = path.join(clientRoot, "utils/dialog.js");
const loginLocationPath = path.join(clientRoot, "utils/login-location.js");
const loginSessionsPath = path.join(clientRoot, "utils/login-sessions.js");
const themePath = path.join(clientRoot, "utils/theme.js");
const accountPagePath = path.join(clientRoot, "pages/account-settings/index.js");
const recordsPagePath = path.join(clientRoot, "pages/login-records/index.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stubModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

function loadPage(pagePath, stubs) {
  const previousPage = global.Page;
  const previousPageModule = require.cache[pagePath];
  const restores = Object.entries(stubs || {}).map(([modulePath, exports]) => (
    stubModule(modulePath, exports)
  ));
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[pagePath];
  try {
    require(pagePath);
  } finally {
    restores.reverse().forEach((restore) => restore());
    if (previousPageModule) require.cache[pagePath] = previousPageModule;
    else delete require.cache[pagePath];
    if (typeof previousPage === "undefined") delete global.Page;
    else global.Page = previousPage;
  }
  assert.ok(definition, `Page definition was not registered for ${pagePath}`);
  const instance = Object.assign({}, definition);
  instance.data = JSON.parse(JSON.stringify(definition.data || {}));
  instance.setData = function setData(values, callback) {
    Object.assign(this.data, values || {});
    if (callback) callback();
  };
  return instance;
}

function locationSession(id, detail, parts) {
  const area = parts || {};
  return {
    id,
    deviceName: `Device ${id}`,
    environment: "iOS",
    loginAddress: "203.0.113.8",
    lastLoginAt: "2026-07-18T10:00:00.000Z",
    statusText: "Current",
    current: true,
    canRevoke: false,
    canDelete: false,
    loginLocation: {
      available: true,
      latitude: 38.9140038,
      longitude: 121.614682,
      accuracyMeters: 8,
      province: area.province || "",
      city: area.city || "",
      district: area.district || "",
      detail: detail || "",
      capturedAt: "2026-07-18T10:00:00.000Z",
    },
  };
}

function accountPayload(session) {
  return {
    user: {},
    sessions: [session],
    sessionCount: 1,
    activeSessionCount: 1,
    hasMoreSessions: false,
  };
}

function themeStub() {
  const rgba = { r: 47, g: 125, b: 80, a: 1 };
  return {
    DEFAULT_CUSTOM_THEME_RGBA: rgba,
    normalizeCustomThemeRgba(value) { return value || rgba; },
    buildCustomTheme() {
      return {
        primary: "#2f7d50",
        primaryDark: "#1c5638",
        accent: "#67a97f",
        pageBg: "#f4f7f5",
      };
    },
    getCurrentTheme() { return { key: "forest", name: "Forest" }; },
    getThemeOptions() { return []; },
    applyPageTheme() {},
  };
}

test("login session decoration maps detail and area fields without reordering", () => {
  delete require.cache[loginSessionsPath];
  const loginSessions = require(loginSessionsPath);
  const decorated = [
    locationSession("newest", "Resolved Road 1"),
    locationSession("middle", "", {
      province: "Liaoning",
      city: "Dalian",
      district: "Shahekou",
    }),
    locationSession("oldest", ""),
  ].map(loginSessions.decorateSession);

  assert.equal(decorated[0].loginLocationText, "Resolved Road 1");
  assert.equal(decorated[1].loginLocationText, "Liaoning \u00b7 Dalian \u00b7 Shahekou");
  assert.equal(
    decorated[2].loginLocationText,
    "\u5750\u6807\u5df2\u8bb0\u5f55\uff0c\u8be6\u7ec6\u5730\u5740\u6682\u4e0d\u53ef\u7528"
  );
  assert.deepEqual(
    loginSessions.filterSessions(decorated, "device").map((session) => session.id),
    ["newest", "middle", "oldest"]
  );
  assert.deepEqual(
    loginSessions.filterSessions(decorated, "shahekou").map((session) => session.id),
    ["middle"]
  );
});

test("forced login session reads bypass cache and stale in-flight responses cannot refill it", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const requests = [];
  global.wx = {
    getStorageSync() { return ""; },
    setStorageSync() {},
    removeStorageSync() {},
    request(options) {
      requests.push(options);
      return { abort() {} };
    },
  };
  global.getApp = () => ({
    globalData: {
      backendMode: "http",
      useHttpBackend: true,
      httpBackendBaseUrl: "https://api.incircle.test",
      httpBackendTimeout: 15000,
      accessToken: "test-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      currentCircleId: "circle-1",
      userId: "user-1",
    },
  });
  delete require.cache[apiPath];
  delete require.cache[authPath];

  try {
    const api = require(apiPath);
    const stalePayload = accountPayload(locationSession("current", ""));
    const freshPayload = accountPayload(locationSession("current", "Resolved Road 1"));
    const initial = api.getLoginSessions();
    const forced = api.getLoginSessions({ force: true });
    await Promise.resolve();
    assert.equal(requests.length, 2);

    requests[1].success({ statusCode: 200, data: { success: true, data: freshPayload } });
    assert.equal((await forced).sessions[0].loginLocation.detail, "Resolved Road 1");
    requests[0].success({ statusCode: 200, data: { success: true, data: stalePayload } });
    await initial;

    const cached = await api.getLoginSessions();
    assert.equal(cached.sessions[0].loginLocation.detail, "Resolved Road 1");
    assert.equal(requests.length, 2);

    const cachedSettings = api.getAccountSettings();
    await Promise.resolve();
    requests[2].success({ statusCode: 200, data: { success: true, data: stalePayload } });
    await cachedSettings;

    const locationWrite = api.updateCurrentLoginLocation({
      latitude: 38.9140038,
      longitude: 121.614682,
    });
    await Promise.resolve();
    requests[3].success({
      statusCode: 200,
      data: { success: true, data: { updated: true, addressResolved: true } },
    });
    await locationWrite;

    const refreshedSettings = api.getAccountSettings();
    const refreshedSessions = api.getLoginSessions();
    await Promise.resolve();
    assert.equal(requests.length, 6);
    requests[4].success({ statusCode: 200, data: { success: true, data: freshPayload } });
    requests[5].success({ statusCode: 200, data: { success: true, data: freshPayload } });
    assert.equal((await refreshedSettings).sessions[0].loginLocation.detail, "Resolved Road 1");
    assert.equal((await refreshedSessions).sessions[0].loginLocation.detail, "Resolved Road 1");
  } finally {
    delete require.cache[apiPath];
    delete require.cache[authPath];
    if (typeof previousWx === "undefined") delete global.wx;
    else global.wx = previousWx;
    if (typeof previousGetApp === "undefined") delete global.getApp;
    else global.getApp = previousGetApp;
  }
});

test("account settings ignores an older response after a forced refresh", async () => {
  const initial = deferred();
  const forced = deferred();
  const calls = [];
  const page = loadPage(accountPagePath, {
    [apiPath]: {
      getAccountSettings(options) {
        calls.push(options);
        return calls.length === 1 ? initial.promise : forced.promise;
      },
    },
    [dialogPath]: {},
    [loginLocationPath]: { readLocationEnvironment() { return {}; } },
    [themePath]: themeStub(),
  });
  page.accountSettingsAlive = true;

  const initialLoad = page.loadSettings();
  const forcedLoad = page.loadSettings({ force: true });
  assert.deepEqual(calls.map((options) => options.force), [false, true]);

  forced.resolve(accountPayload(locationSession("current", "Resolved Road 1")));
  await forcedLoad;
  initial.resolve(accountPayload(locationSession("current", "")));
  await initialLoad;

  assert.equal(page.data.sessions[0].loginLocationText, "Resolved Road 1");
});

test("login records starts a forced refresh and ignores its older request", async () => {
  const previousWx = global.wx;
  const initial = deferred();
  const forced = deferred();
  const calls = [];
  global.wx = { stopPullDownRefresh() {} };
  try {
    const page = loadPage(recordsPagePath, {
      [apiPath]: {
        getLoginSessions(options) {
          calls.push(options);
          return calls.length === 1 ? initial.promise : forced.promise;
        },
      },
      [dialogPath]: {},
    });
    page.loginRecordsAlive = true;

    const initialLoad = page.loadRecords({ loading: true });
    const forcedLoad = page.loadRecords({ force: true, refreshing: true });
    if (calls.length === 1) {
      initial.resolve(accountPayload(locationSession("current", "")));
      await Promise.all([initialLoad, forcedLoad]);
    }
    assert.deepEqual(calls.map((options) => options.force), [false, true]);

    forced.resolve(accountPayload(locationSession("current", "Resolved Road 1")));
    await forcedLoad;
    initial.resolve(accountPayload(locationSession("current", "")));
    await initialLoad;

    assert.equal(page.data.sessions[0].loginLocationText, "Resolved Road 1");
  } finally {
    if (typeof previousWx === "undefined") delete global.wx;
    else global.wx = previousWx;
  }
});
