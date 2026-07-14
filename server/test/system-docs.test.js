const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SYSTEM_DOC_VERSIONS,
  defaultSystemDocs,
  ensureDefaultSystemDocsForCircle,
} = require("../src/system-docs");

function manualText() {
  const manual = defaultSystemDocs().find((doc) => doc.systemKey === "incircle-manual");
  return { manual, text: JSON.stringify(manual) };
}

test("public system manual covers every current member-facing business", () => {
  const { manual, text } = manualText();
  assert.equal(manual.systemVersion, SYSTEM_DOC_VERSIONS["incircle-manual"]);
  [
    /创建自己的熟人圈/,
    /入圈码/,
    /切换当前圈子/,
    /身份卡/,
    /友好印象/,
    /圈友提名/,
    /标签墙/,
    /约局活动/,
    /报名或取消/,
    /AA 账单/,
    /付款人/,
    /普通投票和地点投票/,
    /结果摘要/,
    /文字、图片或数值打卡/,
    /北京时间自然日/,
    /圈内资料/,
    /积分、榜单与勋章/,
    /圈内 AI/,
    /彼此独立的会话/,
    /分享与隐私/,
  ].forEach((pattern) => assert.match(text, pattern));
});

test("public system manual does not expose internal roles or implementation details", () => {
  const { text } = manualText();
  ["超管", "管理员", "JWT", "数据库", "服务端", "API Key"].forEach((word) => {
    assert.equal(text.includes(word), false, `manual should not contain ${word}`);
  });
  ["今日", "今天", "刚刚"].forEach((word) => {
    assert.equal(text.includes(word), false, `manual should not contain unstable wording ${word}`);
  });
});

function memoryDocsDb(initialDocs) {
  const docs = initialDocs.map((row) => Object.assign({}, row, { payload: Object.assign({}, row.payload) }));
  return {
    docs,
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, created_by_user_id")) {
        return { rows: docs.slice(), rowCount: docs.length };
      }
      if (normalized.startsWith("INSERT INTO incircle_docs")) {
        const payload = JSON.parse(params[5]);
        if (docs.some((row) => row.payload.systemKey === payload.systemKey)) return { rows: [], rowCount: 0 };
        docs.push({
          id: params[0],
          circle_id: params[1],
          created_by_user_id: params[2],
          title: params[3],
          category: params[4],
          status: "active",
          payload,
          created_at: payload.createdAt,
          updated_at: payload.createdAt,
        });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE incircle_docs")) {
        const row = docs.find((item) => item.id === params[0]);
        row.title = params[1];
        row.category = params[2];
        row.status = "active";
        row.payload = JSON.parse(params[3]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
}

test("existing system manual is upgraded in place without creating duplicates", async () => {
  const db = memoryDocsDb([
    {
      id: "manual-id",
      circle_id: "circle-id",
      created_by_user_id: "owner-id",
      title: "旧手册",
      category: "指南",
      status: "active",
      payload: {
        id: "manual-id",
        circleId: "circle-id",
        systemKey: "incircle-manual",
        systemManaged: true,
        systemVersion: 1,
        title: "旧手册",
        body: ["旧内容"],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ]);

  const first = await ensureDefaultSystemDocsForCircle(db, "circle-id", "owner-id");
  const second = await ensureDefaultSystemDocsForCircle(db, "circle-id", "owner-id");
  const manualRows = db.docs.filter((row) => row.payload.systemKey === "incircle-manual");
  const badgeRows = db.docs.filter((row) => row.payload.systemKey === "badge-rules");

  assert.deepEqual(first, { inserted: 1, updated: 1, unchanged: 0 });
  assert.deepEqual(second, { inserted: 0, updated: 0, unchanged: 2 });
  assert.equal(manualRows.length, 1);
  assert.equal(badgeRows.length, 1);
  assert.equal(manualRows[0].id, "manual-id");
  assert.equal(manualRows[0].payload.systemVersion, SYSTEM_DOC_VERSIONS["incircle-manual"]);
  assert.match(JSON.stringify(manualRows[0].payload.body), /圈内 AI/);
});
