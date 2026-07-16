const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const gatePath = require.resolve("../../inCircleClient/utils/agreementGate");
const api = require("../../inCircleClient/utils/api");
const auth = require("../../inCircleClient/utils/auth");

function loadGate(options) {
  const settings = options || {};
  const original = {
    clearCache: api.clearCache,
    getSession: api.getSession,
    getAccessToken: auth.getAccessToken,
    handleAgreementRequired: auth.handleAgreementRequired,
  };
  const state = {
    clearCalls: 0,
    sessionCalls: 0,
    redirects: [],
    token: settings.token || "",
  };
  api.clearCache = () => { state.clearCalls += 1; };
  api.getSession = (requestOptions) => {
    state.sessionCalls += 1;
    assert.deepEqual(requestOptions, { force: true });
    return settings.getSession(requestOptions);
  };
  auth.getAccessToken = () => state.token;
  auth.handleAgreementRequired = (error) => {
    state.redirects.push(error);
    return true;
  };
  delete require.cache[gatePath];
  const gate = require(gatePath);
  return {
    gate,
    state,
    restore() {
      api.clearCache = original.clearCache;
      api.getSession = original.getSession;
      auth.getAccessToken = original.getAccessToken;
      auth.handleAgreementRequired = original.handleAgreementRequired;
      delete require.cache[gatePath];
    },
  };
}

test("agreement gate does not create a session for anonymous pages", () => {
  const harness = loadGate({
    token: "",
    getSession() { throw new Error("session must not be requested without a token"); },
  });
  try {
    assert.equal(harness.gate.beforePageShow({ route: "pages/index/index" }), true);
    assert.equal(harness.state.sessionCalls, 0);
  } finally {
    harness.restore();
  }
});

test("agreement gate leaves login, legal, and consent pages accessible", () => {
  const harness = loadGate({
    token: "active-token",
    getSession() { throw new Error("exempt routes must not request a session"); },
  });
  try {
    [
      "pages/login/index",
      "pages/legal/index",
      "pages/agreement-consent/index",
    ].forEach((route) => {
      assert.equal(harness.gate.beforePageShow({ route }), true);
    });
    assert.equal(harness.state.sessionCalls, 0);
  } finally {
    harness.restore();
  }
});

test("agreement gate redirects an authenticated account with no current acceptance", async () => {
  const agreements = {
    required: true,
    reason: "missing",
    termsVersion: "terms-v1",
    privacyVersion: "privacy-v1",
  };
  const harness = loadGate({
    token: "active-token",
    getSession() {
      return Promise.resolve({
        loggedIn: true,
        agreementsAccepted: false,
        agreements,
      });
    },
  });
  try {
    const allowed = await harness.gate.beforePageShow({ route: "pages/index/index" });
    assert.equal(allowed, false);
    assert.equal(harness.state.clearCalls, 1);
    assert.deepEqual(harness.state.redirects, [{
      errCode: "AGREEMENT_ACCEPTANCE_REQUIRED",
      details: agreements,
    }]);
    assert.equal(harness.state.token, "active-token");
  } finally {
    harness.restore();
  }
});

test("agreement gate shares an accepted session check across page shows", async () => {
  let resolveSession;
  const pendingSession = new Promise((resolve) => { resolveSession = resolve; });
  const harness = loadGate({
    token: "active-token",
    getSession() { return pendingSession; },
  });
  try {
    const first = harness.gate.beforePageShow({ route: "pages/index/index" });
    const second = harness.gate.beforePageShow({ route: "pages/tools/index" });
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(harness.state.sessionCalls, 1);
    resolveSession({
      loggedIn: true,
      agreementsAccepted: true,
      agreements: { required: false },
    });
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(harness.gate.beforePageShow({ route: "pages/docs/index" }), true);
    assert.equal(harness.state.sessionCalls, 1);
  } finally {
    harness.restore();
  }
});

test("the global page wrapper checks agreement state before business onShow", () => {
  const source = fs.readFileSync(path.join(ROOT, "inCircleClient/app.js"), "utf8");
  assert.match(source, /const agreementGate = require\("\.\/utils\/agreementGate"\)/);
  assert.match(
    source,
    /config\.onShow = function \(\) \{[\s\S]*agreementGate\.beforePageShow\(page\)[\s\S]*runOriginalOnShow\(\)/
  );
  assert.doesNotMatch(source, /if \(typeof originalOnShow !== "function"\) return/);
  assert.match(source, /!agreementGate\.isCurrentPage\(page\)/);
});
