const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");

const circleId = "11111111-1111-4111-8111-111111111111";
const activityId = "22222222-2222-4222-8222-222222222222";
const creatorUserId = "33333333-3333-4333-8333-333333333333";
const creatorCardId = "44444444-4444-4444-8444-444444444444";
const otherUserId = "55555555-5555-4555-8555-555555555555";
const otherCardId = "66666666-6666-4666-8666-666666666666";

function compactSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function context() {
  return {
    circleId,
    auth: {
      identity: { openid: "creator-openid" },
      user: { id: creatorUserId, openid: "creator-openid" },
    },
    memberCard: { id: creatorCardId, userId: creatorUserId, name: "发起人", avatar: "/creator.png" },
  };
}

test("activity responses are unique per activity and user", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "db", "migrations", "0003_security_and_normalized_actions.sql"),
    "utf8"
  );

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS incircle_activity_responses[\s\S]*?UNIQUE \(activity_id, user_id\)/
  );
});

test("legacy activity host fallback does not duplicate an existing non-coming state", async () => {
  const ctx = context();
  const service = new InCircleService({ db: {}, config: {} }, {});
  service.hydrateActivitiesWithResponses = async (activities) => activities;

  const activities = await service.prepareActivitiesForRuntime([
    {
      id: activityId,
      createdByUserId: creatorUserId,
      hostName: "发起人",
      capacity: 4,
      attendees: [],
      pending: ["发起人"],
      absent: [],
      waitlist: [],
    },
  ], ctx, [ctx.memberCard]);

  assert.deepEqual(activities[0].attendees, []);
  assert.deepEqual(activities[0].pending, ["发起人"]);
  assert.equal(activities[0].myStatus, "待定");
});

test("activity creation stores the creator's default state as one '我来' response", async () => {
  const ctx = context();
  let inTransaction = false;
  let insertedDefaults;
  let insertedIncoming;
  let responseWrite;
  const awards = [];
  const db = {
    async withTransaction(callback) {
      assert.equal(inTransaction, false);
      inTransaction = true;
      try {
        return await callback(this);
      } finally {
        inTransaction = false;
      }
    },
    async query(sql, params) {
      const text = compactSql(sql);
      if (text.startsWith("INSERT INTO incircle_activity_responses")) {
        assert.equal(inTransaction, true);
        responseWrite = { sql: text, params };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const service = new InCircleService({ db, config: {} }, {});
  service.requireCircleContext = async () => ctx;
  service.listMemberDirectory = async () => [
    ctx.memberCard,
    { id: otherCardId, userId: otherUserId, name: "成员乙" },
  ];
  service.insertBusiness = async (kind, actualCircleId, userId, incoming, defaults) => {
    assert.equal(inTransaction, true);
    assert.equal(kind, "activities");
    assert.equal(actualCircleId, circleId);
    assert.equal(userId, creatorUserId);
    insertedIncoming = incoming;
    insertedDefaults = defaults;
    return { id: activityId };
  };
  service.awardRule = async (actualCtx, member, ruleKey) => {
    assert.equal(inTransaction, true);
    assert.equal(actualCtx, ctx);
    assert.equal(member.id, creatorCardId);
    awards.push(ruleKey);
  };
  service.activities = async () => [{ id: activityId }];

  await service.createActivity({
    activity: {
      title: "周末桌游",
      attendees: ["伪造参与者"],
      myStatus: "不来",
    },
  });

  assert.equal(insertedDefaults.myStatus, "我来");
  assert.deepEqual(insertedDefaults.attendees, []);
  assert.equal(Object.hasOwn(insertedIncoming, "attendees"), false);
  assert.equal(Object.hasOwn(insertedIncoming, "myStatus"), false);
  assert.match(responseWrite.sql, /VALUES \(\$1, \$2, \$3, \$4, '我来', 0\)/);
  assert.match(responseWrite.sql, /ON CONFLICT \(activity_id, user_id\) DO UPDATE SET status = EXCLUDED\.status/);
  assert.deepEqual(responseWrite.params, [circleId, activityId, creatorUserId, creatorCardId]);
  assert.deepEqual(awards, ["create_activity"]);
});

test("switching participation atomically replaces only the current member's state", async () => {
  const ctx = context();
  const members = [
    ctx.memberCard,
    { id: otherCardId, userId: otherUserId, name: "成员乙", avatar: "/other.png" },
  ];
  const responses = new Map([
    [creatorUserId, {
      id: "response-creator",
      activity_id: activityId,
      user_id: creatorUserId,
      member_card_id: creatorCardId,
      member_name: "发起人",
      status: "我来",
      plus_one_count: 0,
      created_at: "2026-07-18T01:00:00.000Z",
    }],
    [otherUserId, {
      id: "response-other",
      activity_id: activityId,
      user_id: otherUserId,
      member_card_id: otherCardId,
      member_name: "成员乙",
      status: "不来",
      plus_one_count: 0,
      created_at: "2026-07-18T02:00:00.000Z",
    }],
  ]);
  let inTransaction = false;
  let transactionCount = 0;
  const responseWrites = [];
  const awards = [];
  const db = {
    async withTransaction(callback) {
      assert.equal(inTransaction, false);
      transactionCount += 1;
      inTransaction = true;
      try {
        return await callback(this);
      } finally {
        inTransaction = false;
      }
    },
    async query(sql, params) {
      const text = compactSql(sql);
      if (text.startsWith("SELECT id, status FROM incircle_activities")) {
        assert.equal(inTransaction, true);
        assert.match(text, /FOR UPDATE$/);
        return { rows: [{ id: activityId, status: "报名中" }] };
      }
      if (text.startsWith("SELECT id FROM incircle_activity_responses")) {
        assert.equal(inTransaction, true);
        return { rows: responses.has(params[1]) ? [{ id: responses.get(params[1]).id }] : [] };
      }
      if (text.startsWith("INSERT INTO incircle_activity_responses")) {
        assert.equal(inTransaction, true);
        assert.match(text, /ON CONFLICT \(activity_id, user_id\) DO UPDATE SET status = EXCLUDED\.status/);
        responseWrites.push(text);
        const previous = responses.get(params[2]);
        responses.set(params[2], Object.assign({}, previous, {
          activity_id: params[1],
          user_id: params[2],
          member_card_id: params[3],
          member_name: params[2] === creatorUserId ? "发起人" : "成员乙",
          status: params[4],
          plus_one_count: params[5],
        }));
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM incircle_activity_responses response")) {
        assert.equal(inTransaction, false);
        return { rows: Array.from(responses.values()) };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const service = new InCircleService({ db, config: {} }, {});
  service.requireCircleContext = async () => ctx;
  service.awardRule = async (actualCtx, member, ruleKey) => {
    awards.push(ruleKey);
  };
  service.activities = async () => service.prepareActivitiesForRuntime([
    {
      id: activityId,
      circleId,
      createdByUserId: creatorUserId,
      hostName: "发起人",
      creatorName: "发起人",
      title: "周末桌游",
      status: "报名中",
      capacity: 4,
      tags: ["桌游"],
      attendees: [],
      pending: [],
      absent: [],
      waitlist: [],
    },
  ], ctx, members);

  const cases = [
    { status: "待定", bucket: "pending", need: "缺 4 人", plusOneCount: 0 },
    { status: "不来", bucket: "absent", need: "缺 4 人", plusOneCount: 0 },
    { status: "候补", bucket: "waitlist", need: "缺 4 人", plusOneCount: 0 },
    { status: "带一人", bucket: "attendees", need: "缺 2 人", plusOneCount: 1 },
    { status: "我来", bucket: "attendees", need: "缺 3 人", plusOneCount: 0 },
  ];

  for (const expected of cases) {
    const activities = await service.updateActivityStatus({ id: activityId, status: expected.status });
    const activity = activities[0];
    const creatorBuckets = ["attendees", "pending", "absent", "waitlist"]
      .filter((key) => activity[key].includes("发起人"));

    assert.deepEqual(creatorBuckets, [expected.bucket]);
    assert.equal(activity.myStatus, expected.status);
    assert.equal(activity.capacity, 4);
    assert.equal(activity.status, "报名中");
    assert.equal(activity.plusOneCount, expected.plusOneCount);
    assert.equal(activity.tags.includes(expected.need), true);
    assert.equal(activity.absent.includes("成员乙"), true);
    assert.equal(responses.size, 2);
    assert.equal(responses.get(creatorUserId).status, expected.status);
    assert.equal(responses.get(otherUserId).status, "不来");
    assert.equal(
      activity.responseMembers.filter((member) => member.userId === creatorUserId).length,
      1
    );
  }

  assert.equal(transactionCount, cases.length);
  assert.equal(responseWrites.length, cases.length);
  assert.deepEqual(awards, []);
});
