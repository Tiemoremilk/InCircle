function normalizeMemberRole(value) {
  return value === "圈主" ? "圈主" : "成员";
}

function roleClass(value) {
  return normalizeMemberRole(value) === "圈主" ? "pill-green" : "pill-blue";
}

function decorateMemberRole(source) {
  const member = source || {};
  const role = normalizeMemberRole(member.role);
  return Object.assign({}, member, {
    role,
    roleClass: roleClass(role),
  });
}

module.exports = {
  decorateMemberRole,
  normalizeMemberRole,
  roleClass,
};
