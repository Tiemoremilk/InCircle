const fastifyFactory = require("fastify");
const fs = require("fs");
const cors = require("@fastify/cors");
const helmet = require("@fastify/helmet");
const multipart = require("@fastify/multipart");
const staticFiles = require("@fastify/static");

const { loadConfig } = require("./config");
const { createDatabase } = require("./db");
const { toErrorResponse } = require("./errors");
const { incircleRoutes } = require("./routes/incircle");
const { mediaRoutes } = require("./routes/media");
const { aiRoutes } = require("./routes/ai");
const { formatBeijingDateTime } = require("./time");

async function buildApp(options) {
  const config = (options && options.config) || loadConfig();
  const app = fastifyFactory({
    logger: config.nodeEnv !== "test",
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 1024 * 1024,
  });

  const database = createDatabase(config);
  app.decorate("config", config);
  app.decorate("db", database);
  fs.mkdirSync(config.uploadDir, { recursive: true });

  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, {
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  });
  await app.register(multipart, {
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 1,
    },
  });
  await app.register(staticFiles, {
    root: config.uploadDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  app.get("/health", async (request, reply) => {
    try {
      const db = await app.db.health();
      reply.send({
        ok: true,
        backend: "incircle-server",
        database: {
          ok: true,
          name: config.nodeEnv === "production" ? undefined : db.database_name,
          serverTime: formatBeijingDateTime(db.server_time),
        },
        serverTime: formatBeijingDateTime(),
      });
    } catch (error) {
      reply.code(503).send({
        ok: false,
        backend: "incircle-server",
        database: {
          ok: false,
          errMsg: error.message,
        },
        serverTime: formatBeijingDateTime(),
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const response = toErrorResponse(error, { exposeInternal: config.nodeEnv !== "production" });
    reply.code(response.statusCode).send(response.body);
  });

  await app.register(incircleRoutes, { prefix: "/api" });
  await app.register(aiRoutes, { prefix: "/api" });
  await app.register(mediaRoutes, { prefix: "/api" });

  app.addHook("onClose", async () => {
    await database.close();
  });

  return app;
}

module.exports = {
  buildApp,
};
