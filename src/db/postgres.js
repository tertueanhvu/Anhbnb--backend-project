const { types } = require("pg");
const knex = require("knex");
const config = require("../../knexfile");

// PostgreSQL DATE has no timezone. Keep it as YYYY-MM-DD instead of letting pg
// turn local midnight into a JavaScript Date that can shift by one UTC day.
types.setTypeParser(types.builtins.DATE, (value) => value);

const db = knex(config);

async function checkDatabase() {
  await db.raw("select 1 as ok");
  return true;
}

async function closeDatabase() {
  await db.destroy();
}

module.exports = { db, checkDatabase, closeDatabase };
