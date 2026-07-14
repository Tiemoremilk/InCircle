const MEMBER_ROLES = Object.freeze({
  OWNER: "圈主",
  SUPER_ADMIN: "超管",
  MEMBER: "成员",
});

const OWNER_ROLE_ALIASES = new Set([
  "圈主",
  "owner",
  "circle_owner",
  "circle-owner",
  "creator",
]);

const SUPER_ADMIN_ROLE_ALIASES = new Set([
  "超管",
  "管理员",
  "超级管理员",
  "admin",
  "administrator",
  "manager",
  "circle_admin",
  "circle-admin",
  "super_admin",
  "super-admin",
  "superadmin",
]);

function normalizedRoleKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMemberRole(value) {
  const role = normalizedRoleKey(value);
  if (OWNER_ROLE_ALIASES.has(role)) return MEMBER_ROLES.OWNER;
  if (SUPER_ADMIN_ROLE_ALIASES.has(role)) return MEMBER_ROLES.SUPER_ADMIN;
  return MEMBER_ROLES.MEMBER;
}

function isOwnerRole(value) {
  return normalizeMemberRole(value) === MEMBER_ROLES.OWNER;
}

function isCircleSuperAdminRole(value) {
  return normalizeMemberRole(value) === MEMBER_ROLES.SUPER_ADMIN;
}

function canManageCircleRole(value) {
  const role = normalizeMemberRole(value);
  return role === MEMBER_ROLES.OWNER || role === MEMBER_ROLES.SUPER_ADMIN;
}

function isEnabledClaim(value) {
  if (value === true || value === 1) return true;
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

function hasGlobalSuperAdminClaim(document, options) {
  const doc = document && typeof document === "object" ? document : null;
  if (!doc) return false;
  if ([doc.isSuperAdmin, doc.is_super_admin, doc.superAdmin].some(isEnabledClaim)) return true;
  if (normalizeMemberRole(doc.globalRole) === MEMBER_ROLES.SUPER_ADMIN) return true;
  if (options && options.allowLegacyRole && normalizeMemberRole(doc.role) === MEMBER_ROLES.SUPER_ADMIN) return true;
  const permissions = doc.permissions || doc.permission || {};
  return [permissions.isSuperAdmin, permissions.superAdmin, permissions.globalAdmin].some(isEnabledClaim);
}

module.exports = {
  MEMBER_ROLES,
  canManageCircleRole,
  hasGlobalSuperAdminClaim,
  isCircleSuperAdminRole,
  isOwnerRole,
  normalizeMemberRole,
};
