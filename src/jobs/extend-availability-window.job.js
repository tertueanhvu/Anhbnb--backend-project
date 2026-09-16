const { createIntervalJob } = require("./create-interval-job");

function createExtendAvailabilityWindowJob({ service, logger }) {
  return createIntervalJob({
    name: "extend-availability-window",
    intervalMs: 24 * 60 * 60 * 1000,
    logger,
    task: () => service.extendWindow(),
  });
}

module.exports = { createExtendAvailabilityWindowJob };
