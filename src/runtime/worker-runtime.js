const { createMetrics } = require("../infrastructure/metrics");
const { createRedisClient } = require("../infrastructure/redis/client");
const { createPublicCache } = require("../infrastructure/redis/cache");
const { createInboxRepository } = require("../modules/events/inbox.repository");
const {
  createNotificationConsumer,
} = require("../workers/notification-consumer");
const { createCacheInvalidator } = require("../workers/cache-invalidator");
const { createSearchClient } = require("../infrastructure/search/client");
const {
  createPropertyIndex,
} = require("../infrastructure/search/property-index");
const { createSearchIndexer } = require("../workers/search-indexer");

function createWorkerRuntime({ db, env }) {
  const metrics = createMetrics();
  const redis = createRedisClient({
    url: env.redisUrl,
    commandTimeoutMs: env.redisCommandTimeoutMs,
    metrics,
  });
  const cache = createPublicCache({
    redis,
    namespace: env.redisNamespace,
    metrics,
  });
  const inbox = createInboxRepository(db, metrics);
  const handlers = {
    notification: createNotificationConsumer({ inbox }),
    cache: createCacheInvalidator({ inbox, cache }),
  };
  handlers.search = createSearchIndexer({
    db,
    cache,
    metrics,
    index: createPropertyIndex({
      client: createSearchClient({
        url: env.elasticsearchUrl,
        apiKey: env.elasticsearchApiKey,
      }),
      index: env.elasticsearchIndex,
    }),
  });
  return { handlers, metrics, redis, cache, close: () => redis.close() };
}
module.exports = { createWorkerRuntime };
