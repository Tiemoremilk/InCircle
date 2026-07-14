const OWNER_ROLES = ["圈主", "owner", "circle_owner", "circle-owner", "creator"];
const SUPER_ADMIN_ROLES = [
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
];

function normalizeMemberRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (OWNER_ROLES.indexOf(role) !== -1) return "圈主";
  if (SUPER_ADMIN_ROLES.indexOf(role) !== -1) return "超管";
  return "成员";
}

function roleClass(value) {
  const role = normalizeMemberRole(value);
  if (role === "圈主") return "pill-green";
  if (role === "超管") return "pill-red";
  return "pill-blue";
}

module.exports = {
  normalizeMemberRole,
  roleClass,
};
