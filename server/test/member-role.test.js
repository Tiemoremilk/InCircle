const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MEMBER_ROLES,
  canManageCircleRole,
  hasGlobalSuperAdminClaim,
  isCircleSuperAdminRole,
  isOwnerRole,
  normalizeMemberRole,
} = require("../src/member-role");

test("member roles normalize to the three supported identities", () => {
  assert.equal(normalizeMemberRole("圈主"), MEMBER_ROLES.OWNER);
  assert.equal(normalizeMemberRole("owner"), MEMBER_ROLES.OWNER);
  assert.equal(normalizeMemberRole("管理员"), MEMBER_ROLES.SUPER_ADMIN);
  assert.equal(normalizeMemberRole("admin"), MEMBER_ROLES.SUPER_ADMIN);
  assert.equal(normalizeMemberRole("超管"), MEMBER_ROLES.SUPER_ADMIN);
  assert.equal(normalizeMemberRole("member"), MEMBER_ROLES.MEMBER);
  assert.equal(normalizeMemberRole("未知角色"), MEMBER_ROLES.MEMBER);
});

test("only circle owners and circle super admins can manage a circle", () => {
  assert.equal(isOwnerRole("owner"), true);
  assert.equal(isCircleSuperAdminRole("管理员"), true);
  assert.equal(canManageCircleRole("圈主"), true);
  assert.equal(canManageCircleRole("超管"), true);
  assert.equal(canManageCircleRole("成员"), false);
});

test("circle roles do not implicitly grant platform super admin access", () => {
  assert.equal(hasGlobalSuperAdminClaim({ role: "超管" }), false);
  assert.equal(hasGlobalSuperAdminClaim({ role: "管理员" }), false);
  assert.equal(hasGlobalSuperAdminClaim({ role: "管理员" }, { allowLegacyRole: true }), true);
  assert.equal(hasGlobalSuperAdminClaim({ globalRole: "超管" }), true);
  assert.equal(hasGlobalSuperAdminClaim({ permissions: { globalAdmin: true } }), true);
  assert.equal(hasGlobalSuperAdminClaim({ isSuperAdmin: "false" }), false);
});
