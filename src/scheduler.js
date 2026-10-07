const { getEnv } = require("./config/env");
const { db, checkDatabase, closeDatabase } = require("./db/postgres");
const { logger } = require("./shared/security/logger");
const { createDomainServices } = require("./runtime/domain-services");
const { startSchedulerRuntime } = require("./runtime/scheduler-runtime");
const { startProcessHealth } = require("./runtime/process-health");

async function startScheduler() {
  const env = getEnv();
  if (env.backgroundJobsEnabled)
    throw new Error(
      "Set BACKGROUND_JOBS_ENABLED=false before starting a dedicated scheduler",
    );
  await checkDatabase();
  let runtime,
    health,
    closing = false;
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    await health?.close();
    const deadline = setTimeout(() => process.exit(1), 45000);
    deadline.unref();
    await runtime?.stop();
    await closeDatabase();
    clearTimeout(deadline);
    process.exitCode = code;
  }
  runtime = await startSchedulerRuntime({
    db,
    env,
    services: createDomainServices({ db, env }),
    logger,
    onLost: () => {
      logger.error("Scheduler lost database session; stopping");
      void shutdown(1);
    },
  });
  try {
    health = await startProcessHealth({
      check: async () => {
        if (closing || !runtime) throw new Error("SCHEDULER_NOT_READY");
        await checkDatabase();
      },
    });
  } catch (error) {
    await shutdown(1);
    throw error;
  }
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return runtime;
}
if (require.main === module)
  startScheduler().catch(async (error) => {
    logger.error(
      {
        code:
          error.message === "SCHEDULER_ALREADY_RUNNING"
            ? error.message
            : "SCHEDULER_START_FAILED",
      },
      "Scheduler startup failed",
    );
    await closeDatabase();
    process.exitCode = 1;
  });
module.exports = { startScheduler };
