const { createIntervalJob } = require("./create-interval-job");

function createReconcilePendingPaymentsJob({ service, intervalMs, logger }) {
  return createIntervalJob({
    name: "reconcile-pending-payments",
    intervalMs,
    logger,
    task: () => service.reconcileExpiredBatch(50),
  });
}

module.exports = { createReconcilePendingPaymentsJob };
