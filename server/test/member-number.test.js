const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { formatCircleMemberNumber, reserveCircleMemberNumber } = require("../src/member-number");

test("circle member numbers stay short, stable and human readable", () => {
  assert.equal(formatCircleMemberNumber(1), "M-001");
  assert.equal(formatCircleMemberNumber(28), "M-028");
  assert.equal(formatCircleMemberNumber(1000), "M-1000");
  assert.throws(() => formatCircleMemberNumber(0), /positive integer/);
});

test("circle member number allocation uses one atomic circle counter", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ member_no: 12 }] };
    },
  };

  const value = await reserveCircleMemberNumber(db, "circle-1");

  assert.equal(value, "M-012");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SET next_member_no = next_member_no \+ 1/);
  assert.match(calls[0].sql, /RETURNING next_member_no - 1 AS member_no/);
  assert.deepEqual(calls[0].params, ["circle-1"]);
});

test("member number migration repairs duplicates and enforces circle uniqueness", () => {
  const root = path.resolve(__dirname, "../..");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0016_unique_circle_member_numbers.sql"),
    "utf8"
  );
  const service = fs.readFileSync(path.join(root, "server/src/services/incircle.js"), "utf8");

  assert.match(migration, /row_number\(\) OVER[\s\S]*PARTITION BY circle_id/);
  assert.match(migration, /uq_incircle_circle_member_number/);
  assert.match(migration, /next_member_no/);
  assert.doesNotMatch(service, /['"]m-001['"]/i);
  assert.match(service, /reserveCircleMemberNumber/);
});
