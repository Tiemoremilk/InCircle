const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pagePath = path.resolve(__dirname, "../../inCircleClient/pages/ai-chat/index.js");
const apiPath = path.resolve(__dirname, "../../inCircleClient/utils/api.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assignData(target, key, value) {
  const parts = String(key).replace(/\[(\d+)\]/g, ".$1").split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = /^\d+$/.test(parts[index + 1]) ? [] : {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function createPage(apiMock, storage) {
  delete require.cache[pagePath];
  delete require.cache[apiPath];
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: apiMock };
  let definition = null;
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { userId: "user-1" } });
  global.wx = {
    getStorageSync(key) { return (storage && storage[key]) || ""; },
    setStorageSync(key, value) { if (storage) storage[key] = value; },
    removeStorageSync(key) { if (storage) delete storage[key]; },
    getWindowInfo() { return { windowHeight: 800 }; },
    showToast() {},
    setClipboardData() {},
    hideShareMenu() {},
    onKeyboardHeightChange() {},
    offKeyboardHeightChange() {},
  };
  require(pagePath);
  assert.ok(definition, "AI chat Page definition was not registered");
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => assignData(this.data, key, patch[key]));
      if (typeof callback === "function") callback();
    },
  });
  page.sendLock = false;
  page.liveStreamState = null;
  page.conversationPollTimer = null;
  page.conversationPollId = "";
  page.historyRequestSeq = 0;
  page.typingBottomToggle = false;
  page.data.circleId = "circle-1";
  page.data.status = { assistantName: "圈内 AI", usage: { memberUsed: 0 }, memberDailyLimit: 20 };
  page.data.models = [{
    id: "model-1",
    displayName: "测试模型",
    providerName: "测试供应商",
    reasoningControl: "toggle",
    consented: true,
  }];
  page.data.modelIndex = 0;
  return page;
}

function waitForUi() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test.afterEach(() => {
  delete require.cache[pagePath];
  delete require.cache[apiPath];
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("AI chat restores the prompt when a request fails before server message creation", async () => {
  const failure = Object.assign(new Error("网络不可用"), { errCode: "AI_NETWORK_ERROR" });
  const page = createPage({
    streamAiChat() {
      return { promise: Promise.reject(failure), abort() {} };
    },
  }, {});

  page.startSend("请帮我分析这个问题");
  await waitForUi();

  assert.equal(page.data.messages.length, 0);
  assert.equal(page.data.inputValue, "请帮我分析这个问题");
  assert.equal(page.data.sending, false);
  assert.equal(page.sendLock, false);
});

test("AI chat keeps recovered partial content and marks transport failure as failed, not stopped", async () => {
  const transport = deferred();
  let handlers = null;
  const page = createPage({
    streamAiChat(payload, callbacks) {
      handlers = callbacks;
      return { promise: transport.promise, abort() {}, stop() { return Promise.resolve(); } };
    },
  }, {});

  page.startSend("复杂问题");
  handlers.onStart({ conversationId: "conversation-1", messageId: "message-1", modelName: "测试模型" });
  handlers.onReplaceContent("服务端保存的部分正文", {
    id: "message-1",
    role: "assistant",
    status: "failed",
    content: "服务端保存的部分正文",
    reasoningContent: "服务端保存的思考过程",
    errorCode: "AI_PROVIDER_STREAM_DISCONNECTED",
  });
  transport.reject(Object.assign(new Error("连接中断"), { errCode: "AI_PROVIDER_STREAM_DISCONNECTED" }));
  await waitForUi();

  const assistant = page.data.messages[1];
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.failureTitle, "回答没有完成");
  assert.equal(assistant.content, "服务端保存的部分正文");
  assert.equal(assistant.reasoningContent, "服务端保存的思考过程");
  assert.notEqual(assistant.errorText, "已停止生成");
});

test("AI chat renders each received reasoning and answer delta immediately", () => {
  const page = createPage({}, {});
  const firstReasoning = "思考内容**第一段**。";
  const secondReasoning = "思考内容第二段。";
  const answer = "最终答案包含 **重点**，继续流式出现。";
  page.data.messages = [{
    id: "assistant-stream",
    role: "assistant",
    status: "generating",
    content: "",
    reasoningContent: "",
    reasoningExpanded: true,
    reasoningManual: false,
    reasoningStreaming: true,
    segments: [],
  }];
  page.beginLiveStream(0, page.data.messages[0]);
  page.appendReasoningDelta(firstReasoning);
  assert.equal(page.data.messages[0].reasoningContent, firstReasoning);
  assert.match(page.data.messages[0].reasoningHtml, /<strong>第一段<\/strong>/);
  assert.equal(page.data.messages[0].reasoningStreaming, true);
  page.appendReasoningDelta(secondReasoning);
  assert.equal(page.data.messages[0].reasoningContent, firstReasoning + secondReasoning);
  page.appendAnswerDelta(answer);
  assert.equal(page.data.messages[0].content, answer);
  assert.match(page.data.messages[0].contentHtml, /<strong>重点<\/strong>/);
  assert.equal(page.data.messages[0].reasoningExpanded, false);
  assert.equal(page.data.messages[0].reasoningStreaming, false);
  const snapshot = page.finishLiveStream();
  assert.equal(snapshot.reasoningContent, firstReasoning + secondReasoning);
  assert.equal(snapshot.content, answer);
  const source = fs.readFileSync(pagePath, "utf8");
  assert.doesNotMatch(source, /typewriter/i);
});

test("AI chat auto mode does not render an empty reasoning panel", () => {
  const page = createPage({}, {});
  page.data.messages = [{
    id: "assistant-no-reasoning",
    role: "assistant",
    status: "generating",
    content: "",
    reasoningContent: "",
    hasReasoningContent: false,
    reasoningExpanded: false,
    reasoningStreaming: false,
    reasoningMode: "auto",
    segments: [],
  }];
  page.beginLiveStream(0, page.data.messages[0]);
  page.appendReasoningDelta(" \n\t\u200b\ufeff ");
  page.appendAnswerDelta("直接返回正文");

  assert.equal(page.data.messages[0].reasoningContent, "");
  assert.equal(page.data.messages[0].hasReasoningContent, false);
  assert.equal(page.data.messages[0].reasoningExpanded, false);
  assert.equal(page.data.messages[0].content, "直接返回正文");
  page.disposeLiveStream();
});

test("AI chat retry starts with an empty live stream instead of stale output", () => {
  const page = createPage({}, {});
  page.data.messages = [{
    id: "assistant-old",
    role: "assistant",
    status: "generating",
    content: "旧正文",
    reasoningContent: "旧思考",
  }];
  const retryMessage = {
    id: "assistant-retry",
    role: "assistant",
    status: "generating",
    content: "",
    reasoningContent: "",
  };
  page.resetLiveStreamForRetry(0, retryMessage);
  page.appendReasoningDelta("新思考");
  page.appendAnswerDelta("新正文");
  const snapshot = page.finishLiveStream();
  assert.equal(snapshot.reasoningContent, "新思考");
  assert.equal(snapshot.content, "新正文");
});

test("AI chat reasoning selector defaults to auto and sends the selected next-request mode", () => {
  const storage = {};
  let sentPayload = null;
  const page = createPage({
    streamAiChat(payload) {
      sentPayload = payload;
      return { promise: new Promise(() => {}), abort() {}, stop() { return Promise.resolve(); } };
    },
  }, storage);

  page.onModelChange({ detail: { value: 0 } });
  assert.equal(page.data.reasoningMode, "auto");
  page.onReasoningModeChange({ detail: { value: 2 } });
  assert.equal(page.data.reasoningEnabled, false);
  assert.equal(page.data.reasoningMode, "off");
  assert.equal(storage["incircleAiReasoningMode:user-1:circle-1"], "off");
  page.startSend("请直接回答");
  assert.equal(sentPayload.reasoningMode, "off");
  page.disposeLiveStream();
});

test("AI chat selector keeps unsupported model modes on auto", () => {
  const page = createPage({}, {});
  page.data.models = [
    { id: "reasoner", reasoningControl: "always" },
    { id: "chat", reasoningControl: "none" },
    { id: "hybrid", reasoningControl: "toggle" },
    { id: "unknown", reasoningControl: "prompt" },
  ];
  page.reasoningPreference = "off";

  page.onModelChange({ detail: { value: 0 } });
  assert.equal(page.data.reasoningEnabled, true);
  assert.equal(page.data.reasoningMode, "on");
  assert.deepEqual(page.data.reasoningModeNames, ["思考开"]);

  page.onModelChange({ detail: { value: 1 } });
  assert.equal(page.data.reasoningEnabled, false);
  assert.equal(page.data.reasoningMode, "off");
  assert.deepEqual(page.data.reasoningModeNames, ["思考关"]);

  page.onModelChange({ detail: { value: 2 } });
  assert.equal(page.data.reasoningEnabled, false);
  assert.deepEqual(page.data.reasoningModeNames, ["自动", "思考开", "思考关"]);
  page.onReasoningModeChange({ detail: { value: 1 } });
  assert.equal(page.data.reasoningEnabled, true);
  assert.equal(page.data.reasoningMode, "on");

  page.onModelChange({ detail: { value: 3 } });
  assert.equal(page.data.reasoningMode, "auto");
  assert.deepEqual(page.data.reasoningModeNames, ["自动"]);
});

test("AI chat startup restores the latest remembered conversation instead of creating a blank one", async () => {
  const storage = { "incircleAiLastConversation:user-1:circle-1": "conversation-old" };
  const conversations = [
    { id: "conversation-latest", title: "最新对话", updatedAt: "2026-07-12T08:00:00.000Z" },
    { id: "conversation-old", title: "上次打开", updatedAt: "2026-07-11T08:00:00.000Z" },
  ];
  const page = createPage({
    getAiStatus() {
      return Promise.resolve({
        canChat: true,
        assistantName: "圈内 AI",
        circleName: "测试圈子",
        quickPrompts: [],
        usage: { memberUsed: 0 },
        memberDailyLimit: 20,
        models: [{ id: "model-1", displayName: "测试模型", providerName: "测试供应商", isDefault: true }],
      });
    },
    listAiConversations() {
      return Promise.resolve({ conversations, hasMore: false });
    },
    listAiMessages(circleId, conversationId) {
      return Promise.resolve({
        conversation: Object.assign({}, conversations.find((item) => item.id === conversationId), { modelId: "model-1" }),
        messages: [{ id: "user-message", role: "user", status: "complete", content: "历史问题" }],
        hasMore: false,
      });
    },
  }, storage);

  page.loadInitial("");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(page.data.loading, false);
  assert.ok(page.data.currentConversation, JSON.stringify(page.data));
  assert.equal(page.data.currentConversation.id, "conversation-old");
  assert.equal(page.data.messages[0].content, "历史问题");
});

test("AI chat keeps an independent seconds or minutes duration for each reasoning answer", async () => {
  const page = createPage({
    listAiMessages() {
      return Promise.resolve({
        conversation: { id: "conversation-duration", title: "耗时测试", modelId: "model-1" },
        messages: [
          { id: "assistant-fast", role: "assistant", status: "complete", content: "快速回答", reasoningContent: "快速思考", reasoningDurationMs: 2100 },
          { id: "assistant-slow", role: "assistant", status: "complete", content: "较慢回答", reasoningContent: "较长思考", reasoningDurationMs: 80200 },
        ],
        hasMore: false,
      });
    },
  }, {});

  await page.openConversationById("conversation-duration");

  assert.equal(page.data.messages[0].reasoningDurationText, "2s");
  assert.equal(page.data.messages[1].reasoningDurationText, "1m20s");
  const template = fs.readFileSync(path.resolve(__dirname, "../../inCircleClient/pages/ai-chat/index.wxml"), "utf8");
  assert.match(template, /class="reasoning-duration"[^>]*>\{\{item\.reasoningDurationText\}\}/);
});

test("AI chat live reasoning clock updates only the active answer", () => {
  const page = createPage({}, {});
  page.data.messages = [
    {
      id: "assistant-complete",
      isAssistant: true,
      status: "complete",
      hasReasoningContent: true,
      reasoningDurationMs: 3000,
      reasoningDurationText: "3s",
      reasoningTimingActive: false,
    },
    {
      id: "assistant-active",
      isAssistant: true,
      status: "generating",
      hasReasoningContent: true,
      reasoningDurationMs: 0,
      reasoningDurationText: "",
      reasoningStartedAtMs: Date.now() - 80200,
      reasoningTimingActive: true,
    },
  ];

  page.tickReasoningClock();
  assert.equal(page.data.messages[0].reasoningDurationText, "3s");
  assert.equal(page.data.messages[1].reasoningDurationText, "1m20s");
  page.freezeReasoningDuration(1, 80200);
  assert.equal(page.data.messages[1].reasoningTimingActive, false);
  assert.equal(page.data.messages[1].reasoningDurationText, "1m20s");
  page.clearReasoningClock();
});

test("AI chat keeps reasoning time live and freezes it only when the answer starts", async () => {
  const transport = deferred();
  let handlers = null;
  const page = createPage({
    streamAiChat(payload, callbacks) {
      handlers = callbacks;
      return { promise: transport.promise, abort() {}, stop() { return Promise.resolve(); } };
    },
    getAiStatus() { return Promise.resolve(page.data.status); },
  }, {});
  page.loadConversations = () => Promise.resolve();

  page.startSend("请认真分析");
  await handlers.onStart({
    conversationId: "conversation-live-clock",
    messageId: "assistant-live-clock",
    modelName: "测试模型",
    startedAt: Date.now() - 2200,
  });
  await handlers.onReasoning("第一段思考", { reasoningDurationMs: 2200 });
  let assistant = page.data.messages[1];
  assert.equal(assistant.reasoningContent, "第一段思考");
  assert.equal(assistant.reasoningTimingActive, true);
  assert.equal(assistant.reasoningDurationText, "2s");

  assistant.reasoningStartedAtMs = Date.now() - 3200;
  page.tickReasoningClock();
  assert.equal(page.data.messages[1].reasoningDurationText, "3s");
  await handlers.onReasoning("第二段思考", { reasoningDurationMs: 3200 });
  assert.equal(page.data.messages[1].reasoningContent, "第一段思考第二段思考");

  await handlers.onDelta("正文第一段", { reasoningDurationMs: 3200 });
  assistant = page.data.messages[1];
  assert.equal(assistant.content, "正文第一段");
  assert.equal(assistant.reasoningTimingActive, false);
  assert.equal(assistant.reasoningDurationText, "3s");
  await handlers.onDone({ reasoningDurationMs: 3200 });
  transport.resolve({ done: true });
  await waitForUi();
  assert.equal(page.data.messages[1].status, "complete");
  assert.equal(page.data.messages[1].reasoningDurationText, "3s");
  page.clearReasoningClock();
});
