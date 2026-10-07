const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { createRedisClient } = require("../../src/infrastructure/redis/client");

async function testRedis(url) {
  if (!url)
    throw new Error(
      "Redis tests require REDIS_URL (use ENV_FILE=.env.phase2).",
    );
  const redis = createRedisClient({ url, commandTimeoutMs: 1000 });
  const namespace = `anhbnb:test:${randomUUID()}`;
  for (let n = 0; n < 30 && redis.client.status !== "ready"; n += 1)
    await delay(100);
  if (redis.client.status !== "ready") {
    redis.close();
    throw new Error("Test Redis not ready");
  }
  return {
    redis,
    namespace,
    async cleanup() {
      // Never FLUSHALL: remove only this test run's UUID-scoped keys.
      let cursor = "0";
      do {
        const page = await redis.client.scan(
          cursor,
          "MATCH",
          `${namespace}:*`,
          "COUNT",
          200,
        );
        cursor = page[0];
        if (page[1].length) await redis.client.del(...page[1]);
      } while (cursor !== "0");
      redis.close();
    },
  };
}

function assertTestDatabase(url) {
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("Refusing test writes outside a *_test database");
}
module.exports = { testRedis, assertTestDatabase };
