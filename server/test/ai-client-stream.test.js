const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const apiPath = path.resolve(__dirname, "../../inCircleClient/utils/api.js");
const authPath = path.resolve(__dirname, "../../inCircleClient/utils/auth.js");

function arrayBufferOf(value) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWechatHarness(actionResponder) {
  let streamOptions = null;
  let chunkReceiver = null;
  const actionCalls = [];
  const streamTask = {
    onChunkReceived(callback) {
      chunkReceiver = callback;
    },
    abort() {
      if (streamOptions && typeof streamOptions.fail === "function") {
        streamOptions.fail({ errMsg: "request:fail abort" });
      }
    },
  };
  const wx = {
    getStorageSync() { return ""; },
    setStorageSync() {},
    removeStorageSync() {},
    request(options) {
      if (/\/api\/ai\/chat\/stream$/.test(options.url)) {
        streamOptions = options;
        return streamTask;
      }
      const type = options.data && options.data.type;
      actionCalls.push({ type, data: options.data });
      Promise.resolve()
        .then(() => actionResponder(type, options.data))
        .then((data) => options.success({ statusCode: 200, data: { success: true, data } }))
        .catch((error) => options.fail({ errMsg: error.message }));
      return { abort() {} };
    },
  };
  return {
    wx,
    actionCalls,
    streamOptions() {
      return streamOptions;
    },
    emit(value) {
      assert.equal(typeof chunkReceiver, "function", "stream chunk receiver was not registered");
      chunkReceiver({ data: arrayBufferOf(value) });
    },
    fail(message) {
      streamOptions.fail({ errMsg: message || "request:fail socket closed" });
    },
  };
}

function loadApi(harness) {
  delete require.cache[apiPath];
  delete require.cache[authPath];
  global.wx = harness.wx;
  global.getApp = () => ({
    globalData: {
      backendMode: "http",
      useHttpBackend: true,
      httpBackendBaseUrl: "https://api.incircle.test",
      accessToken: "test-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      currentCircleId: "circle-1",
      userId: "user-1",
    },
  });
  return require(apiPath);
}

test.afterEach(() => {
  delete require.cache[apiPath];
  delete require.cache[authPath];
  delete global.wx;
  delete global.getApp;
});

test("Mini Program AI stream preserves split UTF-8 reasoning and answer events", async () => {
  const harness = createWechatHarness(() => ({}));
  const api = loadApi(harness);
  const events = [];
  const request = api.streamAiChat(
    { circleId: "circle-1", requestId: "request-1" },
    {
      onStart: (event) => events.push(`start:${event.messageId}`),
      onReasoning: (content) => events.push(`reasoning:${content}`),
      onDelta: (content) => events.push(`answer:${content}`),
      onDone: () => events.push("done"),
    }
  );
  const payload = [
    { type: "start", conversationId: "conversation-1", messageId: "message-1" },
    { type: "reasoning", content: "先想清楚" },
    { type: "delta", content: "再回答" },
    { type: "done", conversationId: "conversation-1", messageId: "message-1" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = Buffer.from(payload, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("想", "utf8")) + 1;
  harness.emit(bytes.subarray(0, splitAt));
  harness.emit(bytes.subarray(splitAt));

  await request.promise;
  assert.deepEqual(events, ["start:message-1", "reasoning:先想清楚", "answer:再回答", "done"]);
  assert.equal(harness.streamOptions().enableChunked, true);
  assert.equal(harness.streamOptions().enableHttp2, false);
  assert.equal(harness.streamOptions().enableQuic, false);
  assert.equal(harness.streamOptions().responseType, "arraybuffer");
  assert.equal(harness.streamOptions().header.accept, "text/event-stream");
});

test("Mini Program AI stream de-duplicates replayed ranges after a gateway reconnect", async () => {
  const harness = createWechatHarness(() => ({}));
  const api = loadApi(harness);
  let answer = "";
  const request = api.streamAiChat(
    { circleId: "circle-1", requestId: "request-replay" },
    { onDelta: (content) => { answer += content; } }
  );

  harness.emit([
    { type: "start", conversationId: "conversation-replay", messageId: "message-replay" },
    { type: "delta", content: "你好", offset: 0, endOffset: 2 },
    { type: "delta", content: "你好，续流成功", offset: 0, endOffset: 7, resumed: true },
    { type: "done", conversationId: "conversation-replay", messageId: "message-replay" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

  await request.promise;
  assert.equal(answer, "你好，续流成功");
});

test("Mini Program AI stream waits for each rendered SSE delta before committing the next", async () => {
  const harness = createWechatHarness(() => ({}));
  const api = loadApi(harness);
  const rendered = [];
  let activeRender = 0;
  const request = api.streamAiChat(
    { circleId: "circle-1", requestId: "request-render-queue" },
    {
      onDelta: async (content) => {
        activeRender += 1;
        assert.equal(activeRender, 1);
        rendered.push(`start:${content}`);
        await delay(4);
        rendered.push(`done:${content}`);
        activeRender -= 1;
      },
    }
  );
  const frames = ["逐", "个", "事", "件", "渲", "染"];

  harness.emit([
    { type: "start", conversationId: "conversation-render", messageId: "message-render" },
    ...frames.map((content, offset) => ({ type: "delta", content, offset, endOffset: offset + 1 })),
    { type: "done", conversationId: "conversation-render", messageId: "message-render" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

  await request.promise;
  assert.deepEqual(rendered, frames.flatMap((content) => [`start:${content}`, `done:${content}`]));
  assert.equal(activeRender, 0);
});

test("Mini Program AI recovery syncs saved partial output before reporting a terminal failure", async () => {
  const assistant = {
    id: "message-2",
    role: "assistant",
    status: "failed",
    content: "服务端已保存的部分正文",
    reasoningContent: "已显示的思考以及服务端补全",
    errorCode: "AI_PROVIDER_STREAM_DISCONNECTED",
  };
  const harness = createWechatHarness((type) => {
    assert.equal(type, "incircleAiListMessages");
    return { messages: [assistant], conversation: { id: "conversation-2" } };
  });
  const api = loadApi(harness);
  let reasoning = "";
  let answer = "";
  const request = api.streamAiChat(
    { circleId: "circle-1", requestId: "request-2" },
    {
      onReasoning: (content) => { reasoning += content; },
      onDelta: (content) => { answer += content; },
    }
  );
  harness.emit(`${JSON.stringify({ type: "start", conversationId: "conversation-2", messageId: "message-2" })}\n`);
  harness.emit(`${JSON.stringify({ type: "reasoning", content: "已显示的思考" })}\n`);
  harness.fail("request:fail socket closed");

  await assert.rejects(request.promise, (error) => error.errCode === "AI_PROVIDER_STREAM_DISCONNECTED");
  assert.equal(reasoning, assistant.reasoningContent);
  assert.equal(answer, assistant.content);
  assert.equal(harness.actionCalls.some((call) => call.type === "incircleAiCancelGeneration"), false);
});

test("Mini Program stop action uses authenticated cancellation instead of transport abort semantics", async () => {
  const harness = createWechatHarness((type) => {
    assert.equal(type, "incircleAiCancelGeneration");
    return { cancelled: true, status: "cancelled", messageId: "message-3" };
  });
  const api = loadApi(harness);
  const request = api.streamAiChat({ circleId: "circle-1", requestId: "request-3" }, {});
  harness.emit(`${JSON.stringify({ type: "start", conversationId: "conversation-3", messageId: "message-3" })}\n`);

  const result = await request.stop();
  assert.equal(result.cancelled, true);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.actionCalls[0].type, "incircleAiCancelGeneration");
  await assert.rejects(request.promise, (error) => error.errCode === "AI_CANCELLED");
});
