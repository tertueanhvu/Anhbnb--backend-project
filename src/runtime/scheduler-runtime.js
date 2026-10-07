const {
  createReconcilePendingPaymentsJob,
} = require("../jobs/reconcile-pending-payments.job");
const {
  createExtendAvailabilityWindowJob,
} = require("../jobs/extend-availability-window.job");
const { createIntervalJob } = require("../jobs/create-interval-job");
const { createFreshnessProbes } = require("../modules/search/freshness-probes");

async function startSchedulerRuntime({
  db,
  env,
  services,
  logger,
  onLost = () => {},
}) {
  // Session singleton for scheduling ONLY; never used as an inventory lock.
  const connection = await db.client.acquireConnection();
  const key = 30802026;
  let stopped = false,
    healthPending = false,
    timer;
  const jobs = [
    createReconcilePendingPaymentsJob({
      service: services.paymentService,
      intervalMs: env.reconcileIntervalMs,
      logger,
    }),
    createExtendAvailabilityWindowJob({
      service: services.availabilityService,
      logger,
    }),
  ];
  if (env.searchProbesEnabled) {
    if (!env.outboxEnabled) {
      await db.client.releaseConnection(connection);
      throw new Error("SEARCH_PROBES_REQUIRE_OUTBOX");
    }
    jobs.push(
      createIntervalJob({
        name: "search-freshness-probes",
        intervalMs: 15000,
        logger,
        task: createFreshnessProbes({ db }),
      }),
    );
  }
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all(jobs.map((job) => job.stop()));
    await connection
      .query("SELECT pg_advisory_unlock($1)", [key])
      .catch(() => {});
    connection.removeListener("error", lost);
    await db.client.releaseConnection(connection);
  }
  function lost() {
    if (stopped) return;
    void stop().finally(onLost);
  }
  connection.on("error", lost);
  try {
    const result = await connection.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [key],
    );
    if (!result.rows[0].acquired) throw new Error("SCHEDULER_ALREADY_RUNNING");
    timer = setInterval(async () => {
      if (healthPending || stopped) return;
      healthPending = true;
      try {
        await connection.query({ text: "SELECT 1", query_timeout: 3000 });
      } catch {
        lost();
      } finally {
        healthPending = false;
      }
    }, 5000);
    jobs.forEach((job) => {
      job.start();
      void job.tick();
    });
    logger.info("Scheduler started with PostgreSQL singleton guard");
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
module.exports = { startSchedulerRuntime };
