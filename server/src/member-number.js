function formatCircleMemberNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("Circle member number must be a positive integer.");
  }
  return `M-${String(number).padStart(3, "0")}`;
}

async function reserveCircleMemberNumber(db, circleId) {
  const result = await db.query(
    `UPDATE incircle_circles
     SET next_member_no = next_member_no + 1
     WHERE id = $1
     RETURNING next_member_no - 1 AS member_no`,
    [circleId]
  );
  if (!result.rows[0]) throw new Error("Circle does not exist while allocating a member number.");
  return formatCircleMemberNumber(result.rows[0].member_no);
}

module.exports = {
  formatCircleMemberNumber,
  reserveCircleMemberNumber,
};
