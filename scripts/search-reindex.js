const { parseArgs } = require("node:util");
const { db, closeDatabase } = require("../src/db/postgres");
const { getEnv } = require("../src/config/env");
const { createKafka } = require("../src/infrastructure/kafka/client");
const { createSearchClient } = require("../src/infrastructure/search/client");
const { createRedisClient } = require("../src/infrastructure/redis/client");
const { createPublicCache } = require("../src/infrastructure/redis/cache");
const { reindexSearch } = require("../src/modules/search/reindex");
async function main() {
  const { values } = parseArgs({ options: { index: { type: "string" } } });
  if (!values.index)
    throw new Error(
      "Pass --index NEW_INDEX_NAME; existing indices are never overwritten",
    );
  const env = getEnv();
  const redis = createRedisClient({ url: env.redisUrl });
  try {
    const result = await reindexSearch({
      db,
      target: values.index,
      alias: env.elasticsearchIndex,
      topic: `${env.kafkaTopicPrefix}.catalog.events.v1`,
      kafka: createKafka(env, "anhbnb-rebuild"),
      client: createSearchClient({
        url: env.elasticsearchUrl,
        apiKey: env.elasticsearchApiKey,
        timeoutMs: 10000,
      }),
      cache: createPublicCache({ redis, namespace: env.redisNamespace }),
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Old indices retained. Readiness needs NEW live probes on all partitions. Rollback: SEARCH_BACKEND=pg, or rebuild into another new index; never swap to a stale index.",
    );
  } finally {
    redis.close();
  }
}
main()
  .catch((error) => {
    console.error(error.status ? `SEARCH_HTTP_${error.status}` : error.message);
    console.error(
      "No index deleted. Inspect search_rebuild_runs and maintenance; rerun with a NEW index name after fixing the cause.",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
