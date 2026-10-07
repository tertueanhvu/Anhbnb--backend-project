const Redis = require("ioredis");

function createRedisClient({
  url,
  commandTimeoutMs = 100,
  circuitMs = 1000,
  metrics,
}) {
  let unavailableUntil = 0;
  let closed = false;
  const client = url
    ? new Redis(url, {
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        commandTimeout: commandTimeoutMs,
        connectTimeout: 1000,
        autoResendUnfulfilledCommands: false,
        retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
      })
    : null;
  // Consume connection errors without logging URLs/passwords on every reconnect.
  client?.on("error", () => metrics?.increment("redis.connection_error"));
  client?.on("ready", () => {
    unavailableUntil = 0;
  });

  return {
    client,
    async execute(operation) {
      if (
        closed ||
        !client ||
        client.status !== "ready" ||
        Date.now() < unavailableUntil
      ) {
        throw new Error("REDIS_UNAVAILABLE");
      }
      try {
        return await operation(client);
      } catch (error) {
        unavailableUntil = Date.now() + circuitMs;
        metrics?.increment("redis.command_error");
        throw error;
      }
    },
    close() {
      closed = true;
      client?.disconnect();
    },
  };
}

module.exports = { createRedisClient };
