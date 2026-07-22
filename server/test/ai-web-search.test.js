const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { AiService } = require("../src/services/ai");
const { WebSearchService, normalizeResults } = require("../src/services/ai/web-search");

const ROOT = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("SearXNG results are normalized, de-duplicated and limited", () => {
  const results = normalizeResults("北京天气", [
    { title: "北京天气", url: "https://weather.example/path?utm_source=x", content: "晴朗" },
    { title: "北京天气", url: "https://weather.example/path", content: "重复" },
    { title: "气象局", url: "https://weather.gov.example/today", content: "权威预报", publishedDate: "2026-07-22" },
    { title: "无效", url: "javascript:alert(1)", content: "x" },
  ], 8);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://weather.example/path");
  assert.equal(results[1].source, "weather.gov.example");
});

test("web search calls only the configured server-side JSON endpoint", async () => {
  let requested;
  const service = new WebSearchService({
    searxngEnabled: true,
    searxngBaseUrl: "https://search.incircle.asia",
    searxngLanguage: "zh-CN",
    searxngSafesearch: 1,
    searxngMaxResultsPerQuery: 8,
  }, {
    request: async (url) => {
      requested = url;
      return { statusCode: 200, body: JSON.stringify({ results: [{ title: "结果", url: "https://example.com/a", content: "摘要" }] }) };
    },
  });
  const results = await service.search("测试", { userKey: "u1" });
  assert.equal(requested.origin, "https://search.incircle.asia");
  assert.equal(requested.pathname, "/search");
  assert.equal(requested.searchParams.get("format"), "json");
  assert.equal(results.length, 1);
});

test("search mode obeys off and explicit auto-mode opt-out", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const prepared = { content: "请不要联网，解释二分查找" };
  assert.equal((await service.decideWebSearch(prepared, "off", "", null)).needSearch, false);
  assert.equal((await service.decideWebSearch(prepared, "auto", "", null)).needSearch, false);
});

test("search planning uses full Shanghai server time for auto and forced modes", async () => {
  const prompts = [];
  const service = new AiService({ db: {}, config: { searxngMaxQueriesPerRound: 3, aiProviderTimeoutMs: 300000 } }, {
    now: () => new Date("2026-07-22T07:36:20.000Z"),
  });
  service.collectModelText = async (options) => {
    prompts.push(options.messages[0].content);
    return { content: '{"need_search":true,"reason":"实时问题","queries":["上海 2026年7月22日 天气"]}', usage: {} };
  };
  const prepared = { content: "今天天气如何", model: {}, generationPlan: { messages: [{ role: "user", content: "今天天气如何" }] } };
  assert.equal((await service.decideWebSearch(prepared, "auto", "key")).needSearch, true);
  assert.equal((await service.decideWebSearch(prepared, "on", "key")).needSearch, true);
  prompts.forEach((prompt) => assert.match(prompt, /2026-07-22 15:36:20 \+08:00 \(Asia\/Shanghai\)/));
  assert.doesNotMatch(read("server/src/services/ai.js"), /const timely =/);
});

test("the fastest query streams each unique result before slower queries finish", async () => {
  const events = [];
  let slowFinished = false;
  const service = new AiService({ db: {}, config: { searxngMaxQueriesPerRound: 3, searxngMaxRounds: 1 } }, {
    webSearchService: {
      configured: () => true,
      async search(query) {
        if (query === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          slowFinished = true;
          return [{ title: "慢结果", url: "https://slow.example/a", source: "slow.example", snippet: "", query }];
        }
        return [
          { title: "快结果", url: "https://fast.example/a", source: "fast.example", snippet: "", query },
          { title: "重复结果", url: "https://fast.example/a", source: "fast.example", snippet: "", query },
        ];
      },
    },
  });
  service.decideWebSearch = async () => ({ needSearch: true, queries: ["slow", "fast"], usage: {} });
  service.persistSearchMetadata = async () => {};
  const metadata = await service.prepareWebSearch({
    body: { searchMode: "on" }, content: "测试", assistantMessage: {},
    ctx: { platformWebSearchEnabled: true, circleId: "c", auth: { user: { id: "u" } } },
  }, "key", async (event) => {
    events.push({ type: event.type, source: event.result && event.result.source, slowFinished });
  });
  const firstResult = events.find((event) => event.type === "search_result");
  assert.deepEqual(firstResult, { type: "search_result", source: "fast.example", slowFinished: false });
  assert.equal(events.filter((event) => event.type === "search_result").length, 2);
  assert.equal(metadata.results.length, 2);
});

test("platform search control and chat selector are wired and hidden by status", () => {
  const migration = read("server/db/migrations/0038_ai_web_search.sql");
  const admin = read("inCircleClient/pages/admin/index.wxml");
  const chat = read("inCircleClient/pages/ai-chat/index.wxml");
  assert.match(migration, /web_search_enabled boolean NOT NULL DEFAULT false/);
  assert.match(admin, /bindchange="togglePlatformSearch"/);
  assert.match(chat, /wx:if="\{\{status\.webSearchEnabled\}\}"/);
  assert.match(chat, /bindchange="onSearchModeChange"/);
  assert.match(read("inCircleClient/pages/ai-chat/index.js"), /正在补充搜索/);
  assert.match(chat, /class="chat-mode-row"/);
  const styles = read("inCircleClient/pages/ai-chat/index.wxss");
  assert.match(styles, /\.chat-mode-row\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*flex-end/s);
  assert.match(styles, /\.search-mode-mark\s*\{[^}]*width:\s*24rpx[^}]*margin-right:\s*7rpx/s);
  assert.doesNotMatch(read("server/src/services/ai.js"), /const suffix = `\\n\\n来源/);
  assert.match(read("server/src/routes/incircle.js"), /incircleAiSearchProgress/);
  assert.match(read("inCircleClient/utils/api.js"), /function getAiSearchProgress/);
});

test("search progress is scoped to the requesting member and returns persisted metadata", async () => {
  let queryArgs;
  const service = new AiService({ db: { query: async (sql, args) => {
    queryArgs = args;
    return { rows: [{ message_id: "message-1", message_status: "generating", search_metadata: { phase: "searching", progressVersion: 3 } }] };
  } }, config: {} }, {});
  service.requireMember = async () => ({ circleId: "circle-1", auth: { user: { id: "user-1" } } });
  const progress = await service.searchProgress({ requestId: "ai_request_1" });
  assert.deepEqual(queryArgs, ["circle-1", "user-1", "ai_request_1"]);
  assert.equal(progress.messageStatus, "generating");
  assert.equal(progress.search.progressVersion, 3);
});
