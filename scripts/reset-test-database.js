const knex = require("knex");
const config = require("../knexfile");

async function main() {
  const url = new URL(config.connection);
  if (
    process.env.NODE_ENV !== "test" ||
    !/_test$/.test(url.pathname.slice(1))
  ) {
    throw new Error(
      "Refusing reset: NODE_ENV=test and a database ending in _test are required.",
    );
  }
  const db = knex(config);
  try {
    await db.migrate.rollback(undefined, true);
    await db.migrate.latest();
    await db.seed.run();
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
