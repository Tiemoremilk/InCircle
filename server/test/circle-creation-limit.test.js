const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");

const ROOT = path.join(__dirname, "..", "..");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CIRCLE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function createCircleHarness(options) {
  const source = options || {};
  const queries = [];
  let transactionOpen = false;
  let joinCodeRequested = false;
  const db = {
    async withTransaction(callback) {
      assert.equal(transactionOpen, false);
      transactionOpen = true;
      try {
        return await callback();
      } finally {
        transactionOpen = false;
      }
    },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params, transactionOpen });
      assert.equal(transactionOpen, true, `query must run in the creation transaction: ${normalized}`);
      if (normalized === "SELECT id FROM incircle_users WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: USER_ID }] };
      }
      if (normalized === "SELECT count(*)::int AS total FROM incircle_circles WHERE owner_user_id = $1") {
        return { rows: [{ total: Number(source.ownedCount || 0) }] };
      }
      if (normalized.startsWith("INSERT INTO incircle_circles")) {
        return { rows: [{ id: CIRCLE_ID, name: "新的熟人圈", status: "active" }] };
      }
      if (normalized.startsWith("UPDATE incircle_circles SET next_member_no")) {
        return { rows: [{ member_no: 1 }] };
      }
      if (normalized.startsWith("INSERT INTO incircle_circle_members")) {
        return { rows: [{ id: MEMBERSHIP_ID }] };
      }
      if (normalized.startsWith("INSERT INTO incircle_member_cards")) return { rows: [] };
      if (normalized.startsWith("UPDATE incircle_users SET current_circle_id")) {
        return { rows: [{ id: USER_ID, current_circle_id: CIRCLE_ID, status: "active" }] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "owner-openid" },
    user: {
      id: USER_ID,
      nickname: "圈主",
      avatar_url: "/images/avatar.png",
      is_super_admin: !!source.isSuperAdmin,
    },
  });
  service.createUniqueJoinCode = async () => {
    assert.equal(transactionOpen, true, "join code must be allocated after the quota check enters the transaction");
    joinCodeRequested = true;
    return "ABCDEFGH";
  };
  service.ensureDefaultDocsForCircle = async () => {};
  service.ensureDefaultScoreRulesForCircle = async () => {};
  service.logOperation = async () => {};
  service.buildSession = async (user) => ({ user, circleCreated: true });
  return {
    service,
    queries,
    joinCodeRequested: () => joinCodeRequested,
  };
}

test("ordinary account can create its tenth circle and the quota check runs before writes", async () => {
  const harness = createCircleHarness({ ownedCount: 9 });
  const result = await harness.service.createCircle({ circle: { name: "第十个圈子" } });
  assert.equal(result.circleCreated, true);
  assert.equal(harness.joinCodeRequested(), true);

  const lockIndex = harness.queries.findIndex((query) => /FOR UPDATE$/.test(query.sql));
  const countIndex = harness.queries.findIndex((query) => /count\(\*\)::int AS total FROM incircle_circles/.test(query.sql));
  const insertIndex = harness.queries.findIndex((query) => query.sql.startsWith("INSERT INTO incircle_circles"));
  assert.ok(lockIndex >= 0 && lockIndex < countIndex && countIndex < insertIndex);
  assert.doesNotMatch(harness.queries[countIndex].sql, /status/i);
});

test("ordinary account at or above the limit is rejected without partial circle data", async () => {
  for (const ownedCount of [10, 12]) {
    const harness = createCircleHarness({ ownedCount });
    await assert.rejects(
      harness.service.createCircle({ circle: { name: "不应创建" } }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.errCode, "CIRCLE_CREATE_LIMIT_REACHED");
        assert.deepEqual(error.details, { limit: 10, ownedCount });
        return true;
      }
    );
    assert.equal(harness.joinCodeRequested(), false);
    assert.equal(harness.queries.some((query) => query.sql.startsWith("INSERT INTO")), false);
  }
});

test("only a platform superadmin bypasses the ownership limit", async () => {
  const platformAdmin = createCircleHarness({ ownedCount: 25, isSuperAdmin: true });
  const result = await platformAdmin.service.createCircle({ circle: { name: "平台管理圈" } });
  assert.equal(result.circleCreated, true);
  assert.equal(platformAdmin.queries.some((query) => /FOR UPDATE$/.test(query.sql)), false);
  assert.equal(platformAdmin.queries.some((query) => /AS total FROM incircle_circles/.test(query.sql)), false);

  const circleRoleOnly = createCircleHarness({ ownedCount: 10, isSuperAdmin: false });
  await assert.rejects(
    circleRoleOnly.service.createCircle({ circle: { name: "圈内超管不豁免" }, role: "超管" }),
    (error) => error.errCode === "CIRCLE_CREATE_LIMIT_REACHED"
  );
});

test("my-circle summary exposes ownership quota independently from joined circles", async () => {
  const db = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("count(*) OVER()::int AS filtered_total")) {
        return {
          rows: [{
            id: CIRCLE_ID,
            owner_user_id: USER_ID,
            name: "常用圈子",
            notice: "",
            slogan: "",
            status: "active",
            member_count: 2,
            monthly_activity_count: 0,
            unsettled_count: 0,
            role: "圈主",
            membership_status: "active",
            joined_at: "2026-07-01T00:00:00.000Z",
            last_entered_at: "2026-07-12T00:00:00.000Z",
            filtered_total: 1,
          }],
        };
      }
      if (normalized.includes("AS joined_count") && normalized.includes("AS owned_circle_count")) {
        return { rows: [{ joined_count: 1, managed_count: 1, owned_circle_count: 10 }] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "owner-openid" },
    user: { id: USER_ID, nickname: "圈主", current_circle_id: null, is_super_admin: false },
  });

  const result = await service.listMyCircles({ limit: 3, offset: 0 });
  assert.equal(result.joinedCount, 1);
  assert.equal(result.ownedCircleCount, 10);
  assert.equal(result.circleCreateLimit, 10);
  assert.equal(result.canCreateCircle, false);
});

test("migration and themed mini-program UI carry the circle quota contract", () => {
  const migration = read("server/db/migrations/0018_circle_creation_limit.sql");
  const schema = read("server/db/schema.sql");
  const page = read("inCircleClient/pages/circle-switch/index.js");
  const markup = read("inCircleClient/pages/circle-switch/index.wxml");
  const styles = read("inCircleClient/pages/circle-switch/index.wxss");

  assert.match(migration, /idx_incircle_circles_owner_user_id[\s\S]*owner_user_id/);
  assert.match(schema, /idx_incircle_circles_owner_user_id[\s\S]*incircle_circles\(owner_user_id\)/);
  assert.match(page, /CIRCLE_CREATE_LIMIT_REACHED/);
  assert.match(page, /showCircleCreateLimitDialog/);
  assert.match(markup, /已创建 \{\{ownedCircleCount\}\} \/ \{\{circleCreateLimit\}\}/);
  assert.match(markup, /已达创建上限/);
  assert.match(styles, /\.circle-list-shell/);
  assert.match(styles, /\.circle-launchpad[\s\S]*var\(--theme-soft/);
  assert.match(styles, /\.create-quota[\s\S]*var\(--theme-primary-dark/);
});
