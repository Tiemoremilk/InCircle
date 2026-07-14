const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService, __test } = require("../src/services/incircle");

test("two friendly impressions promote the tag to the wall", () => {
  const state = __test.friendlyTagWallState([], [], "靠谱", 2);
  assert.equal(state.promoted, true);
  assert.equal(state.becamePromoted, true);
  assert.deepEqual(state.tags, ["靠谱"]);
  assert.deepEqual(state.autoTags, ["靠谱"]);
});

test("falling below two votes removes only automatically promoted tags", () => {
  const autoTag = __test.friendlyTagWallState(["靠谱", "摄影"], ["靠谱"], "靠谱", 1);
  assert.deepEqual(autoTag.tags, ["摄影"]);
  assert.deepEqual(autoTag.autoTags, []);

  const manualTag = __test.friendlyTagWallState(["靠谱"], [], "靠谱", 1);
  assert.deepEqual(manualTag.tags, ["靠谱"]);
});

test("member card shows promoted database tags when legacy payload tags are stale", () => {
  const card = __test.memberCardFromRow(
    {
      id: "card-1",
      circle_id: "circle-1",
      role: "成员",
      name: "成员甲",
      score: 0,
      weekly_score: 0,
      tags: ["好约"],
      badges: [],
      payload: { tags: [], badges: [] },
    },
    { id: "user-1", nickname: "成员甲" },
    { role: "成员" }
  );

  assert.deepEqual(card.tags, ["好约"]);
});

test("friendly voting locks the target card before counting and promotion", async () => {
  const queries = [];
  const updates = [];
  const awards = [];
  const db = {
    async withTransaction(callback) {
      return callback(this);
    },
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      queries.push(text);
      if (text.includes("SELECT tags, payload FROM incircle_member_cards") && text.includes("FOR UPDATE")) {
        return { rows: [{ tags: [], payload: {} }] };
      }
      if (text.includes("SELECT id FROM incircle_member_tag_votes")) return { rows: [] };
      if (text.startsWith("INSERT INTO incircle_member_tag_votes")) return { rows: [{ id: "vote-2" }] };
      if (text.includes("SELECT count(*)::int AS count FROM incircle_member_tag_votes")) {
        return { rows: [{ count: 2 }] };
      }
      if (text.startsWith("UPDATE incircle_member_cards SET tags")) {
        updates.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const service = new InCircleService({ db, config: {} }, {});
  service.requireCircleContext = async () => ({
    circleId: "circle-1",
    auth: { user: { id: "voter-2" } },
    memberCard: { id: "voter-card-2", name: "成员乙" },
  });
  service.getMemberCardForTag = async () => ({
    row: { tags: [], payload: {} },
    member: { id: "target-card", userId: "target-user", circleId: "circle-1", name: "目标成员", avatar: "/images/avatar.png" },
  });
  service.awardRule = async (ctx, member, ruleKey) => {
    awards.push(ruleKey);
    return true;
  };
  service.logOperation = async () => {};
  service.memberDetail = async () => ({ id: "target-card", tags: ["靠谱"] });

  const result = await service.addMemberTag({ id: "target-card", tag: "靠谱" });

  assert.match(queries[0], /FOR UPDATE$/);
  assert.deepEqual(JSON.parse(updates[0][1]), ["靠谱"]);
  assert.deepEqual(JSON.parse(updates[0][2]).autoFriendlyTags, ["靠谱"]);
  assert.deepEqual(awards, ["friendly_impression", "friendly_promotion"]);
  assert.deepEqual(result.friendlyAction, {
    tag: "靠谱",
    added: true,
    count: 2,
    promoted: true,
    becamePromoted: true,
  });
});

test("home leaderboard stays empty until member scores are comparable", () => {
  assert.deepEqual(__test.scoreLeaderboard([{ id: "a", score: 0 }, { id: "b", score: 0 }], 3), []);
  assert.deepEqual(__test.scoreLeaderboard([{ id: "a", score: 5 }, { id: "b", score: 5 }], 3), []);
  const ranked = __test.scoreLeaderboard(
    [{ id: "a", score: 2 }, { id: "b", score: 8 }, { id: "c", score: 4 }, { id: "d", score: 4 }],
    4
  );
  assert.deepEqual(ranked.map((item) => item.id), ["b", "c", "d", "a"]);
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 2, 4]);
  assert.deepEqual(ranked.map((item) => item.score), [8, 4, 4, 2]);
});

test("home leaderboard renders the rank supplied by the server", () => {
  const markup = fs.readFileSync(
    path.join(__dirname, "..", "..", "inCircleClient", "pages", "index", "index.wxml"),
    "utf8"
  );
  assert.match(markup, /class="leader-rank">\{\{item\.rank\}\}/);
  assert.doesNotMatch(markup, /class="leader-rank">\{\{index \+ 1\}\}/);
});
