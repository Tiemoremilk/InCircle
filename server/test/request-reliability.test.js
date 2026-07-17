const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");

const apiPath = path.resolve(__dirname, "../../inCircleClient/utils/api.js");
const loginPath = path.resolve(__dirname, "../../inCircleClient/pages/login/index.js");
const authPath = path.resolve(__dirname, "../../inCircleClient/utils/auth.js");

function loadApi(responder) {
  delete require.cache[apiPath];
  delete require.cache[authPath];
  const calls = [];
  const requestOptions = [];
  global.wx = {
    getStorageSync() { return ""; },
    setStorageSync() {},
    removeStorageSync() {},
    request(options) {
      calls.push(options.data && options.data.type);
      requestOptions.push(options);
      Promise.resolve().then(() => responder(options, calls.length));
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
  return { api: require(apiPath), calls, requestOptions };
}

test.afterEach(() => {
  delete require.cache[apiPath];
  delete require.cache[authPath];
  delete global.wx;
  delete global.getApp;
});

test("a transient read failure is retried once for every read endpoint", async () => {
  const harness = loadApi((options, count) => {
    if (count === 1) {
      options.fail({ errMsg: "request:fail timeout" });
      return;
    }
    options.success({
      statusCode: 200,
      data: { success: true, data: [{ id: "activity-1" }] },
    });
  });

  const activities = await harness.api.listActivities();
  assert.equal(activities[0].id, "activity-1");
  assert.deepEqual(harness.calls, ["incircleActivities", "incircleActivities"]);
  assert.equal(harness.requestOptions.every((options) => options.timeout === 15000), true);
});

test("management reads use the same transient retry policy", async () => {
  const harness = loadApi((options, count) => {
    if (count === 1) {
      options.success({ statusCode: 503, data: { success: false, errCode: "BUSY" } });
      return;
    }
    options.success({
      statusCode: 200,
      data: { success: true, data: { circleCount: 3, userCount: 8 } },
    });
  });

  const overview = await harness.api.adminOverview();
  assert.equal(overview.circleCount, 3);
  assert.deepEqual(harness.calls, ["incircleAdminOverview", "incircleAdminOverview"]);
});

test("write requests are never replayed after a transient network failure", async () => {
  const harness = loadApi((options) => options.fail({ errMsg: "request:fail timeout" }));

  await assert.rejects(
    harness.api.createActivity({ title: "不会重复创建" }),
    (error) => error.errCode === "HTTP_RESPONSE_TIMEOUT"
  );
  assert.deepEqual(harness.calls, ["incircleCreateActivity"]);
});

test("database-idempotent agreement acceptance is safely retried once", async () => {
  const harness = loadApi((options, count) => {
    if (count === 1) {
      options.fail({ errMsg: "request:fail timeout" });
      return;
    }
    options.success({
      statusCode: 200,
      data: {
        success: true,
        data: {
          loggedIn: true,
          agreementsAccepted: true,
          agreements: { termsVersion: "terms-v2", privacyVersion: "privacy-v2" },
        },
      },
    });
  });

  const session = await harness.api.acceptAgreements({
    accepted: true,
    termsVersion: "terms-v2",
    privacyVersion: "privacy-v2",
  });
  assert.equal(session.agreementsAccepted, true);
  assert.deepEqual(harness.calls, ["incircleAcceptAgreements", "incircleAcceptAgreements"]);
});

test("ordinary HTTP requests rely on WeChat native timeout without a competing JS timer", () => {
  const source = fs.readFileSync(apiPath, "utf8");
  const loginSource = fs.readFileSync(loginPath, "utf8");
  assert.match(source, /wx\.request\(\{[\s\S]*?timeout,/);
  assert.doesNotMatch(source, /function withTimeout|Promise\.race\(\[request, timeout\]\)/);
  assert.doesNotMatch(source, /timeout \+ 1000/);
  assert.match(loginSource, /return api\.getSession\(\{ force: true \}\)/);
  assert.doesNotMatch(loginSource, /sessionTimer|sessionTimeout|Promise\.race\(\[sessionCheck/);
});

test("member reads do not run initialization writes", async () => {
  const queries = [];
  const service = new InCircleService({
    config: {},
    db: {
      async query(sql) {
        queries.push(String(sql));
        return { rows: [] };
      },
    },
  });
  service.listMemberDirectory = async () => [];
  service.hydrateMemberSocialState = async (members) => members;
  service.circleMonthlyHonors = async () => [];
  service.ensureDefaultScoreRulesForCircle = async () => {
    throw new Error("member reads must not initialize score rules");
  };

  const result = await service.listMembersData("circle-1", "user-1");
  assert.deepEqual(result.members, []);
  assert.equal(queries.some((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("default score rules are initialized with one bulk query", async () => {
  const calls = [];
  const service = new InCircleService({
    config: {},
    db: {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        return { rows: [] };
      },
    },
  });

  await service.ensureDefaultScoreRulesForCircle("11111111-1111-4111-8111-111111111111");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /jsonb_to_recordset/i);
  assert.equal(JSON.parse(calls[0].params[1]).length, 12);
});

test("activity enrichment uses the shared lightweight member directory", async () => {
  const service = new InCircleService({ config: {}, db: {} });
  service.hydrateActivitiesWithResponses = async (activities) => activities;
  service.listMemberDirectory = async () => [
    { id: "member-1", userId: "user-1", name: "小林" },
    { id: "member-2", userId: "user-2", name: "小周" },
  ];
  service.listMembersData = async () => {
    throw new Error("activity enrichment must not load scores and social state");
  };

  const activities = await service.prepareActivitiesForRuntime(
    [{ id: "activity-1", createdByUserId: "user-1", attendees: ["小林"] }],
    {
      circleId: "circle-1",
      memberCard: { id: "member-1", name: "小林" },
      auth: { user: { id: "user-1" } },
    }
  );
  assert.equal(activities[0].hostName, "小林");
  assert.deepEqual(activities[0].silent, ["小周"]);
});

test("tool collections start together instead of waiting in sequence", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const service = new InCircleService({ config: {}, db: {} });
  service.requireCircleContext = async () => ({
    circleId: "circle-1",
    memberCard: { id: "member-1" },
    auth: { user: { id: "user-1" } },
  });
  service.listMembersData = async () => {
    started.push("members");
    await gate;
    return { members: [], myCard: null, scoreRules: [], scoreLogs: [], monthlyHonors: [] };
  };
  service.listBusiness = async (kind) => {
    started.push(kind);
    await gate;
    return [];
  };
  service.prepareVotesForRuntime = async (votes) => votes;

  const pending = service.tools({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    new Set(started),
    new Set(["members", "bills", "votes", "checkins", "decisions"])
  );
  release();
  await pending;
});

test("document reads do not reconcile system documents", async () => {
  const service = new InCircleService({ config: {}, db: {} });
  service.requireCircleContext = async () => ({
    circleId: "circle-1",
    auth: { user: { id: "user-1" } },
  });
  service.ensureDefaultDocsForCircle = async () => {
    throw new Error("document reads must not reconcile system documents");
  };
  service.listBusiness = async () => [{ id: "doc-1" }];

  const docs = await service.docs({});
  assert.equal(docs[0].id, "doc-1");
});
