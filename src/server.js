const { createApp } = require("./app");
const { getEnv } = require("./config/env");
const { checkDatabase, closeDatabase } = require("./db/postgres");
const { logger } = require("./shared/security/logger");
const { createApiRouter } = require("./routes");
const {
  createReconcilePendingPaymentsJob,
} = require("./jobs/reconcile-pending-payments.job");
const {
  createExtendAvailabilityWindowJob,
} = require("./jobs/extend-availability-window.job");

async function startServer() {
  const env = getEnv();
  await checkDatabase();
  const apiRouter = createApiRouter();
  const app = createApp({ checkDatabase, apiRouter });
  const jobs = env.backgroundJobsEnabled
    ? [
        createReconcilePendingPaymentsJob({
          service: apiRouter.runtimeServices.paymentService,
          intervalMs: env.reconcileIntervalMs,
          logger,
        }),
        createExtendAvailabilityWindowJob({
          service: apiRouter.runtimeServices.availabilityService,
          logger,
        }),
      ]
    : [];
  const server = app.listen(env.port, () =>
    logger.info({ port: env.port }, "API listening"),
  );
  jobs.forEach((job) => job.start());

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown started");
    jobs.forEach((job) => job.stop());
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
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
