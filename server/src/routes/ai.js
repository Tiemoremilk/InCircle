const { AppError } = require("../errors");
const { AiService, registerActiveGeneration } = require("../services/ai");

const STREAM_HEARTBEAT_MS = 2000;
const STREAM_TRANSPORT_VERSION = "sse-v2";
const STREAM_PRELUDE = `:${" ".repeat(4096)}\n\n`;

function streamFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function writeResponseChunk(response, content) {
  if (!response || response.destroyed || response.writableEnded) return Promise.resolve(false);
  if (response.write(content)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      response.removeListener("drain", done);
      response.removeListener("close", done);
      response.removeListener("error", done);
      resolve(!response.destroyed && !response.writableEnded);
    };
    response.once("drain", done);
    response.once("close", done);
    response.once("error", done);
  });
}

function streamError(error) {
  const known = error instanceof AppError;
  return {
    type: "error",
    errCode: (error && (error.errCode || error.code)) || "AI_GENERATION_FAILED",
    errMsg: known ? error.message : "AI 回答生成失败，请稍后重试",
    details: known ? error.details : undefined,
  };
}

function watchClientDisconnect(request, reply, isFinished, onDisconnect) {
  const shouldMark = () => !isFinished();
  const onRequestAborted = () => {
    if (shouldMark()) onDisconnect();
  };
  const onResponseClose = () => {
    if (shouldMark() && reply.raw.destroyed) onDisconnect();
  };
  request.raw.once("aborted", onRequestAborted);
  reply.raw.once("close", onResponseClose);
  return () => {
    request.raw.removeListener("aborted", onRequestAborted);
    reply.raw.removeListener("close", onResponseClose);
  };
}

async function aiRoutes(fastify, options) {
  const ServiceClass = (options && options.AiServiceClass) || AiService;
  fastify.post("/ai/chat/stream", async (request, reply) => {
    const service = new ServiceClass(fastify, { request });
    const controller = new AbortController();
    let streamStarted = false;
    let streamFinished = false;
    let clientDisconnected = false;
    let heartbeatTimer = null;
    let unregisterGeneration = null;

    const unwatchClientDisconnect = watchClientDisconnect(
      request,
      reply,
      () => streamFinished,
      () => { clientDisconnected = true; }
    );

    const stopHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
    const startHeartbeat = () => {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        if (streamFinished || reply.raw.destroyed || reply.raw.writableEnded) return;
        writeResponseChunk(reply.raw, streamFrame({ type: "ping", sentAt: Date.now() })).catch(() => {});
      }, STREAM_HEARTBEAT_MS);
      if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
    };

    const emit = async (event) => {
      if (event && event.type === "start" && event.messageId && !unregisterGeneration) {
        unregisterGeneration = registerActiveGeneration(event.messageId, controller);
      }
      if (!streamStarted) {
        streamStarted = true;
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
        reply.raw.setHeader("cache-control", "no-cache, no-store, no-transform");
        reply.raw.setHeader("content-encoding", "identity");
        reply.raw.setHeader("x-accel-buffering", "no");
        reply.raw.setHeader("x-incircle-stream-version", STREAM_TRANSPORT_VERSION);
        if (reply.raw.socket && typeof reply.raw.socket.setNoDelay === "function") reply.raw.socket.setNoDelay(true);
        if (reply.raw.socket && typeof reply.raw.socket.setKeepAlive === "function") reply.raw.socket.setKeepAlive(true, 10000);
        if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
        await writeResponseChunk(reply.raw, STREAM_PRELUDE);
        startHeartbeat();
      }
      await writeResponseChunk(reply.raw, streamFrame(Object.assign({}, event, { sentAt: Date.now() })));
    };

    try {
      await service.chatStream(request.body || {}, emit, controller.signal);
      streamFinished = true;
      if (streamStarted && !reply.raw.destroyed) reply.raw.end();
      if (!streamStarted) reply.send({ success: true, data: null });
    } catch (error) {
      streamFinished = true;
      if (!streamStarted) throw error;
      request.log.warn({
        errCode: (error && (error.errCode || error.code)) || "AI_GENERATION_FAILED",
        aiDiagnostics: (error && error.aiDiagnostics) || undefined,
        clientDisconnected,
      }, "AI generation failed");
      if (!reply.raw.destroyed) {
        await writeResponseChunk(reply.raw, streamFrame(streamError(error)));
        reply.raw.end();
      }
    } finally {
      stopHeartbeat();
      unwatchClientDisconnect();
      if (unregisterGeneration) unregisterGeneration();
    }
  });
}

module.exports = {
  aiRoutes,
  streamFrame,
  watchClientDisconnect,
};
