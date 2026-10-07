const { setTimeout: delay } = require("node:timers/promises");

// Retry only errors for which PostgreSQL has rolled back the entire transaction.
// Never retry ambiguous connection/commit failures here (use the API idempotency key).
async function transactionWithRetry(
  db,
  operation,
  { attempts = 3, sleep = delay } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(operation);
    } catch (error) {
      if (!["40P01", "40001"].includes(error.code) || attempt >= attempts)
        throw error;
      await sleep(20 * attempt + Math.floor(Math.random() * 30));
    }
  }
}

module.exports = { transactionWithRetry };
