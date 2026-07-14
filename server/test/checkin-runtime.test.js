const assert = require("node:assert/strict");
const test = require("node:test");
const { InCircleService, __test } = require("../src/services/incircle");

test("check-in runtime summary never renders missing streak fields", () => {
  const empty = __test.checkinRuntimeMetrics({ records: [] }, "2026-07-12");
  assert.equal(empty.streakChampion, "");
  assert.equal(empty.streakDays, 0);
  assert.equal(empty.streakLabel, "连续榜待开启");
  assert.equal(empty.weeklySummary, "本周还没有打卡记录。");
  assert.doesNotMatch(empty.weeklySummary, /undefined|null/i);
});

test("check-in runtime summary calculates Beijing-date streaks", () => {
  const records = [
    { id: "r1", userId: "u1", memberName: "小林", checkinDate: "2026-07-10", createdAt: "2026-07-10T00:00:00.000Z" },
    { id: "r2", userId: "u1", memberName: "小林", checkinDate: "2026-07-11", createdAt: "2026-07-11T00:00:00.000Z" },
    { id: "r3", userId: "u1", memberName: "小林", checkinDate: "2026-07-12", createdAt: "2026-07-12T00:00:00.000Z" },
    { id: "r4", userId: "u2", memberName: "阿青", checkinDate: "2026-07-12", createdAt: "2026-07-12T01:00:00.000Z" },
  ];
  const result = __test.checkinRuntimeMetrics({ records }, "2026-07-12");
  assert.equal(result.streakChampion, "小林");
  assert.equal(result.streakDays, 3);
  assert.equal(result.streakLabel, "小林 · 连续 3 天");
  assert.match(result.weeklySummary, /2 人留下 4 条打卡记录/);
  assert.deepEqual(result.rankings.streakKing[0], {
    name: "小林",
    label: "连续保持中",
    value: "3 天",
  });
});

test("check-in media accepts uploaded URLs and rejects temporary paths", () => {
  const result = __test.normalizeCheckinMedia(
    [{ src: "https://api.example.com/uploads/checkins/a.jpg", path: "uploads/checkins/a.jpg" }],
    { src: "https://api.example.com/uploads/checkins/a.jpg" }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].src, "https://api.example.com/uploads/checkins/a.jpg");
  assert.deepEqual(__test.normalizeCheckinMedia([], { src: "wxfile://temporary.jpg" }), []);
});

test("only the record owner can replace missing check-in media", async () => {
  const calls = [];
  const app = {
    db: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ id: params[0] }] };
      },
    },
    config: {},
  };
  const service = new InCircleService(app, {});
  service.requireCircleContext = async () => ({
    circleId: "11111111-1111-4111-8111-111111111111",
    auth: { user: { id: "22222222-2222-4222-8222-222222222222" } },
    memberCard: { id: "33333333-3333-4333-8333-333333333333" },
  });
  service.getBusiness = async () => ({ id: "44444444-4444-4444-8444-444444444444" });

  await service.updateCheckinRecordMedia({
    id: "44444444-4444-4444-8444-444444444444",
    recordId: "55555555-5555-4555-8555-555555555555",
    image: { src: "https://api.example.com/uploads/checkins/repaired.jpg" },
  });

  assert.match(calls[0].sql, /AND user_id = \$4/);
  assert.equal(calls[0].params[3], "22222222-2222-4222-8222-222222222222");
});
