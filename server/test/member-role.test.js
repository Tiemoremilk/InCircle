const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MEMBER_ROLES,
  canManageCircleRole,
  hasGlobalSuperAdminClaim,
  isOwnerRole,
  normalizeMemberRole,
} = require("../src/member-role");
const { InCircleService } = require("../src/services/incircle");

test("member roles normalize to owner or member without promoting legacy admins", () => {
  assert.equal(normalizeMemberRole("圈主"), MEMBER_ROLES.OWNER);
  assert.equal(normalizeMemberRole("owner"), MEMBER_ROLES.OWNER);
  assert.equal(normalizeMemberRole("管理员"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("admin"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("超管"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("member"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("未知角色"), MEMBER_ROLES.MEMBER);
});

test("only circle owners receive management rights from a membership role", () => {
  assert.equal(isOwnerRole("owner"), true);
  assert.equal(canManageCircleRole("圈主"), true);
  assert.equal(canManageCircleRole("超管"), false);
  assert.equal(canManageCircleRole("管理员"), false);
  assert.equal(canManageCircleRole("成员"), false);
});

test("legacy circle roles never become global super admin claims", () => {
  assert.equal(hasGlobalSuperAdminClaim({ role: "超管" }), false);
  assert.equal(hasGlobalSuperAdminClaim({ role: "管理员" }), false);
  assert.equal(hasGlobalSuperAdminClaim({ role: "管理员" }, { allowLegacyRole: true }), false);
  assert.equal(hasGlobalSuperAdminClaim({ globalRole: "超管" }), true);
  assert.equal(hasGlobalSuperAdminClaim({ permissions: { globalAdmin: true } }), true);
  assert.equal(hasGlobalSuperAdminClaim({ isSuperAdmin: "false" }), false);
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
