const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const fastifyFactory = require("fastify");

const { aiRoutes } = require("../src/routes/ai");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("AI route delivers SSE frames over separate real HTTP chunks", async () => {
  class FakeAiService {
    async chatStream(body, emit) {
      await emit({ type: "start", messageId: "message-stream-test" });
      await delay(45);
      await emit({ type: "reasoning", content: "第一段思考" });
      await delay(45);
      await emit({ type: "delta", content: "第一段正文" });
      await delay(20);
      await emit({ type: "done", messageId: "message-stream-test" });
    }
  }

  const app = fastifyFactory({ logger: false });
  await app.register(aiRoutes, { prefix: "/api", AiServiceClass: FakeAiService });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();

  try {
    const received = await new Promise((resolve, reject) => {
      const chunks = [];
      const request = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/ai/chat/stream",
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (response) => {
        response.on("data", (chunk) => chunks.push({ at: Date.now(), text: chunk.toString("utf8") }));
        response.on("end", () => resolve({ response, chunks, endedAt: Date.now() }));
      });
      request.on("error", reject);
      request.end("{}");
    });

    const body = received.chunks.map((chunk) => chunk.text).join("");
    const meaningful = received.chunks.filter((chunk) => /data:\s*\{/.test(chunk.text));
    assert.match(String(received.response.headers["content-type"]), /^text\/event-stream/);
    assert.equal(received.response.headers["x-incircle-stream-version"], "sse-v2");
    assert.match(body, /"type":"reasoning"/);
    assert.match(body, /"type":"delta"/);
    assert.match(body, /"type":"done"/);
    assert.equal(meaningful.length >= 4, true);
    assert.equal(meaningful.at(-1).at - meaningful[0].at >= 80, true);
    assert.equal(received.endedAt >= meaningful.at(-1).at, true);
  } finally {
    await app.close();
  }
});
