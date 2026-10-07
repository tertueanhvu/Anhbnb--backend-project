const { getEnv } = require("./src/config/env");

const env = getEnv();

module.exports = {
  client: "pg",
  connection: env.migrationDatabaseUrl,
  pool: { min: 0, max: env.nodeEnv === "test" ? 5 : 10 },
  migrations: { directory: "./migrations" },
  seeds: { directory: "./seeds" },
};
