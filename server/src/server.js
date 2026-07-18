const { buildApp } = require("./app");
const { loadConfig } = require("./config");
const { beginAiShutdown, recoverExpiredAiGenerations } = require("./services/ai");
const { clearExpiredAccountSessionLocations } = require("./account-sessions");

const LOGIN_LOCATION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const app = await buildApp({ config });
  const recovered = await recoverExpiredAiGenerations(app.db);
  if (recovered.rowCount) {
    app.log.warn({ recoveredAiGenerations: recovered.rowCount }, "Recovered expired AI generations");
  }
  const clearExpiredLoginLocations = async () => {
    try {
      const cleared = await clearExpiredAccountSessionLocations(app.db);
      if (cleared) app.log.info({ clearedLoginLocations: cleared }, "Cleared expired login locations");
    } catch (error) {
      app.log.error(error, "Expired login-location cleanup failed");
    }
  };
  await clearExpiredLoginLocations();
  const loginLocationCleanupTimer = setInterval(
    clearExpiredLoginLocations,
    LOGIN_LOCATION_CLEANUP_INTERVAL_MS
  );
  if (typeof loginLocationCleanupTimer.unref === "function") loginLocationCleanupTimer.unref();
  await app.listen({
    host: config.host,
    port: config.port,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(loginLocationCleanupTimer);
    const forceExitTimer = setTimeout(() => {
      app.log.error({ signal }, "Graceful shutdown timed out");
      process.exit(1);
    }, 25000);
    if (typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    try {
      const interrupted = await beginAiShutdown(app.db);
      app.log.info({ signal, interruptedAiGenerations: interrupted.rowCount }, "Shutting down InCircle API");
      await app.close();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      app.log.error(error, "Graceful shutdown failed");
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => { shutdown("SIGTERM"); });
  process.once("SIGINT", () => { shutdown("SIGINT"); });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
