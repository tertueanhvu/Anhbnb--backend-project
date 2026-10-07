const { types } = require("pg");
const knex = require("knex");
const config = require("../../knexfile");
const { getEnv } = require("../config/env");
const { createDependencyProbe } = require("../runtime/dependency-probe");

// PostgreSQL DATE has no timezone. Keep it as YYYY-MM-DD instead of letting pg
// turn local midnight into a JavaScript Date that can shift by one UTC day.
types.setTypeParser(types.builtins.DATE, (value) => value);

// Runtime must never inherit the migration role from the Knex CLI config.
const db = knex({ ...config, connection: getEnv().databaseUrl });
const probe = createDependencyProbe(() =>
  db.raw("select 1 as ok").timeout(1000, { cancel: true }),
);

async function checkDatabase() {
  return probe();
}

async function closeDatabase() {
  await db.destroy();
}

module.exports = { db, checkDatabase, closeDatabase };
