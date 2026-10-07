const { createApp } = require("./app");
const { getEnv } = require("./config/env");
const { db, checkDatabase, closeDatabase } = require("./db/postgres");
const { logger } = require("./shared/security/logger");
const { createApiRouter } = require("./routes");
const { startSchedulerRuntime } = require("./runtime/scheduler-runtime");

async function startServer() {
  const env = getEnv();
  await checkDatabase();
  const apiRouter = createApiRouter();
  const app = createApp({ checkDatabase, apiRouter });
  const scheduler = env.backgroundJobsEnabled
    ? await startSchedulerRuntime({
        db,
        env,
        services: apiRouter.runtimeServices,
        logger,
        onLost: () => void shutdown("scheduler-session-lost", 1),
      })
    : null;
  const server = app.listen(env.port, () =>
    logger.info({ port: env.port }, "API listening"),
  );

  let shuttingDown = false;
  async function shutdown(signal, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown started");
    const deadline = setTimeout(() => process.exit(1), 45000);
    deadline.unref();
    const drainedJobs = scheduler?.stop();
    server.close(async () => {
      await drainedJobs;
      apiRouter.close();
      await closeDatabase();
      clearTimeout(deadline);
      process.exit(code);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.fatal({ err: error }, "Server startup failed");
    process.exit(1);
  });
}

module.exports = { startServer };
