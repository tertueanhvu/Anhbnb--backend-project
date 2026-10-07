const { parseArgs } = require("node:util");
const { getEnv } = require("../src/config/env");
const { db, closeDatabase } = require("../src/db/postgres");
const { createWorkerRuntime } = require("../src/runtime/worker-runtime");
const { replayEvent } = require("../src/modules/events/replay");
async function main() {
  const { values } = parseArgs({
    options: {
      consumer: { type: "string" },
      "event-id": { type: "string" },
      confirm: { type: "boolean", default: false },
      "allow-notification": { type: "boolean", default: false },
    },
  });
  const runtime = createWorkerRuntime({ db, env: getEnv() });
  try {
    const result = await replayEvent({
      db,
      handlers: runtime.handlers,
      consumerName: values.consumer,
      eventId: values["event-id"],
      confirm: values.confirm,
      allowNotification: values["allow-notification"],
    });
    console.log(JSON.stringify(result));
  } finally {
    runtime.close();
  }
}
main()
  .catch((error) => {
    console.error(
      /^(REPLAY_|NOTIFICATION_REPLAY_)/.test(error.message)
        ? error.message
        : "REPLAY_FAILED; no failure marked resolved before sink completion",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
