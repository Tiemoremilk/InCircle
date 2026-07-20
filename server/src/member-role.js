const MEMBER_ROLES = Object.freeze({
  OWNER: "圈主",
  MEMBER: "成员",
});

function normalizeMemberRole(value) {
  return value === MEMBER_ROLES.OWNER
    ? MEMBER_ROLES.OWNER
    : MEMBER_ROLES.MEMBER;
}

function isOwnerRole(value) {
  return normalizeMemberRole(value) === MEMBER_ROLES.OWNER;
}

module.exports = {
  MEMBER_ROLES,
  isOwnerRole,
  normalizeMemberRole,
};
