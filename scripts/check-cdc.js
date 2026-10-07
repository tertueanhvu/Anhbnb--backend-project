const axios = require("axios");
const { getEnv } = require("../src/config/env");
const { db, closeDatabase } = require("../src/db/postgres");

async function main() {
  const env = getEnv();
  const { data } = await axios.get(
    `${env.kafkaConnectUrl}/connectors/anhbnb-outbox/status`,
    { timeout: 5000 },
  );
  const slots = await db.raw(
    "SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::text AS retained_wal_bytes FROM pg_replication_slots WHERE slot_name = 'anhbnb_outbox_slot'",
  );
  const tasks = data.tasks.map((task) => ({ id: task.id, state: task.state }));
  // Never print Connect config, task traces or resolved credentials.
  console.log(
    JSON.stringify(
      { connector: data.connector.state, tasks, slots: slots.rows },
      null,
      2,
    ),
  );
  if (
    data.connector.state !== "RUNNING" ||
    !tasks.length ||
    tasks.some((task) => task.state !== "RUNNING")
  )
    process.exitCode = 1;
}
main()
  .catch((error) => {
    console.error(`CDC check failed: ${error.code || "CONNECT_UNAVAILABLE"}`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
