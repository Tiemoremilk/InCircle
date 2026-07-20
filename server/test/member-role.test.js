const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MEMBER_ROLES,
  isOwnerRole,
  normalizeMemberRole,
} = require("../src/member-role");
const { InCircleService } = require("../src/services/incircle");
const clientMemberRole = require("../../inCircleClient/utils/memberRole");

test("member roles accept only the two canonical database values", () => {
  assert.equal(normalizeMemberRole("圈主"), MEMBER_ROLES.OWNER);
  assert.equal(normalizeMemberRole(" 圈主 "), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("owner"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("circle_owner"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("管理员"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("admin"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("超管"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("member"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("未知角色"), MEMBER_ROLES.MEMBER);
});

test("only the canonical circle-owner role receives ownership semantics", () => {
  assert.equal(isOwnerRole("圈主"), true);
  assert.equal(isOwnerRole("owner"), false);
  assert.equal(isOwnerRole("超管"), false);
  assert.equal(isOwnerRole("管理员"), false);
  assert.equal(isOwnerRole("成员"), false);
});

test("Mini Program role decoration uses the same two-value circle contract", () => {
  assert.equal(clientMemberRole.normalizeMemberRole("圈主"), "圈主");
  assert.equal(clientMemberRole.normalizeMemberRole("成员"), "成员");
  assert.equal(clientMemberRole.normalizeMemberRole("超管"), "成员");
  assert.equal(clientMemberRole.normalizeMemberRole("owner"), "成员");
  assert.deepEqual(clientMemberRole.decorateMemberRole({ id: "member-1", role: "圈主" }), {
    id: "member-1",
    role: "圈主",
    roleClass: "pill-green",
  });
  const circleSettings = fs.readFileSync(
    path.join(__dirname, "..", "..", "inCircleClient", "pages", "circle-settings", "index.js"),
    "utf8"
  );
  assert.match(circleSettings, /source\.role === "未加入"/);
});

test("circle management combines ownership with either global super admin source", () => {
  const service = new InCircleService({ db: {}, config: { superAdminOpenids: ["configured-admin"] } }, {});
  const member = { role: "成员" };

  assert.equal(
    service.canManageCircle({ identity: { openid: "owner" }, user: { id: "owner" } }, { role: "圈主" }),
    true
  );
  assert.equal(
    service.canManageCircle(
      { identity: { openid: "database-admin" }, user: { id: "database-admin", is_super_admin: true } },
      null
    ),
    true
  );
  assert.equal(
    service.canManageCircle(
      { identity: { openid: "configured-admin" }, user: { id: "configured-admin", is_super_admin: false } },
      null
    ),
    true
  );
  assert.equal(
    service.canManageCircle({ identity: { openid: "legacy" }, user: { id: "legacy" } }, { role: "超管" }),
    false
  );
  assert.equal(
    service.canManageCircle({ identity: { openid: "member" }, user: { id: "member" } }, member),
    false
  );
});

test("a configured global super admin manages circle settings without a membership", async () => {
  const circleId = "11111111-1111-4111-8111-111111111111";
  const db = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized === "SELECT * FROM incircle_circles WHERE id = $1 LIMIT 1") {
        return {
          rows: [{
            id: circleId,
            name: "测试圈子",
            status: "active",
            member_count: 1,
            monthly_activity_count: 0,
            unsettled_count: 0,
          }],
        };
      }
      if (normalized.startsWith("SELECT * FROM incircle_circle_members WHERE circle_id = $1")) {
        return { rows: [] };
      }
      if (normalized.includes("FROM incircle_circle_members m") && normalized.includes("JOIN incircle_users u")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: ["configured-admin"] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "configured-admin" },
    user: { id: "admin-user", openid: "configured-admin", is_super_admin: false },
  });
  service.platformSettings = async () => ({ circleAiEnabled: true });

  const settings = await service.circleSettings({ circleId });

  assert.equal(settings.canManage, true);
  assert.equal(settings.circle.canManage, true);
  assert.equal(settings.canExit, false);
  assert.equal(settings.canDissolve, false);
});

test("non-member global super admin access remains explicit per circle endpoint", async () => {
  const circleId = "11111111-1111-4111-8111-111111111111";
  const db = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM incircle_circle_members m") && normalized.includes("JOIN incircle_circles c")) {
        return { rows: [] };
      }
      if (normalized === "SELECT id, status, name FROM incircle_circles WHERE id = $1 LIMIT 1") {
        return { rows: [{ id: circleId, status: "active", name: "测试圈子" }] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: ["configured-admin"] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "configured-admin" },
    user: { id: "admin-user", openid: "configured-admin", is_super_admin: false },
  });

  await assert.rejects(
    () => service.requireCircleContext({ circleId }),
    (error) => error.statusCode === 403 && error.errCode === "NOT_IN_CIRCLE"
  );
  const context = await service.requireCircleContext({ circleId }, { allowSuperAdmin: true });
  assert.equal(context.membership, null);
  assert.equal(context.memberCard, null);
  assert.equal(context.superAdminAccess, true);
});

test("a non-member global super admin can remove an ordinary circle member", async () => {
  const circleId = "11111111-1111-4111-8111-111111111111";
  const membershipId = "22222222-2222-4222-8222-222222222222";
  const targetUserId = "33333333-3333-4333-8333-333333333333";
  const writes = [];
  const db = {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT * FROM incircle_circle_members WHERE circle_id = $1")) {
        return { rows: [] };
      }
      if (normalized.includes("SELECT membership.*, circle.owner_user_id")) {
        return {
          rows: [{
            id: membershipId,
            circle_id: circleId,
            user_id: targetUserId,
            owner_user_id: "44444444-4444-4444-8444-444444444444",
            member_name: "普通成员",
            role: "成员",
            status: "active",
          }],
        };
      }
      writes.push({ sql: normalized, params });
      return { rows: [], rowCount: 1 };
    },
    async withTransaction(work) {
      return work();
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: ["configured-admin"] } }, {});
  service.requireUser = async () => ({
    identity: { openid: "configured-admin" },
    user: { id: "admin-user", openid: "configured-admin", is_super_admin: false },
  });
  service.logOperation = async () => {};
  service.circleSettings = async () => ({ canManage: true });

  const result = await service.removeCircleMember({ circleId, membershipId });

  assert.equal(result.canManage, true);
  const membershipUpdate = writes.find((entry) => entry.sql.includes("UPDATE incircle_circle_members"));
  assert.ok(membershipUpdate);
  assert.equal(membershipUpdate.params[1], "管理中心移除成员");
  assert.equal(membershipUpdate.params[2], "admin-user");
});

test("role migration keeps platform claims separate and canonicalizes every circle row", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "db", "migrations", "0036_remove_circle_super_admin_role.sql"),
    "utf8"
  );

  assert.match(schema, /is_super_admin boolean NOT NULL DEFAULT false/);
  assert.doesNotMatch(schema, /CHECK \(role IN \([^)]*'超管'/);
  assert.doesNotMatch(migration, /CHECK \(role IN \([^)]*'超管'/);
  assert.match(migration, /circle\.owner_user_id = member\.user_id THEN '圈主'/);
  assert.match(migration, /circle\.owner_user_id = card\.user_id THEN '圈主'/);
  assert.doesNotMatch(migration, /WHERE[^;]*status\s*=/i);
  assert.equal((migration.match(/CHECK \(role IN \('圈主', '成员'\)\)/g) || []).length, 2);
});
