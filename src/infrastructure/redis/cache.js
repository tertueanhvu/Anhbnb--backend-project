const { createHash, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { RELEASE } = require("./lock");
const { AppError } = require("../../shared/errors/app-error");

const GENERATION = `local value = redis.call('GET', KEYS[1])
if not value then redis.call('SET', KEYS[1], ARGV[1], 'NX'); value = redis.call('GET', KEYS[1]) end
return value`;
const FILL = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end`;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hashQuery = (value) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

// All source work stays in a bounded queue, even while Redis is unavailable.
function createSourceGate({
  concurrency = 20,
  maxQueue = 100,
  deadlineMs = 2000,
} = {}) {
  let active = 0;
  const queue = [];
  function startNext() {
    while (active < concurrency && queue.length) {
      const task = queue.shift();
      if (task.expired) continue;
      active += 1;
      // A timed-out caller does not free its slot while source I/O is still running.
      Promise.resolve()
        .then(task.load)
        .then(task.resolve, task.reject)
        .finally(() => {
          clearTimeout(task.timer);
          active -= 1;
          startNext();
        });
    }
  }
  return (load) =>
    new Promise((resolve, reject) => {
      if (queue.length >= maxQueue)
        return reject(
          new AppError(
            503,
            "CATALOG_BUSY",
            "Catalog đang quá tải, hãy thử lại.",
          ),
        );
      const task = { load, resolve, reject, expired: false };
      task.timer = setTimeout(() => {
        task.expired = true;
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        reject(
          new AppError(
            503,
            "CATALOG_TIMEOUT",
            "Catalog chưa phản hồi kịp thời.",
          ),
        );
      }, deadlineMs);
      queue.push(task);
      startNext();
    });
}

function createPublicCache({
  redis,
  namespace,
  enabled = true,
  metrics,
  random = Math.random,
  sourceGate = createSourceGate(),
}) {
  const flights = new Map();
  const generationKey = (kind, scope) => `${namespace}:gen:${kind}:${scope}`;
  const dataKey = (kind, scope, generation, query) =>
    kind === "property"
      ? `${namespace}:cache:property:v1:${scope}:${generation}:vi-VN`
      : `${namespace}:cache:${kind}:v1:${scope}:${generation}:${hashQuery(query)}`;

  async function readValue(key, validate, kind) {
    const raw = await redis.execute((client) => client.get(key));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!validate(parsed)) throw new Error("INVALID_PUBLIC_DTO");
      return parsed;
    } catch {
      metrics?.increment(`cache.${kind}.invalid_value`);
      return undefined;
    }
  }

  return {
    generationKey,
    dataKey,
    async invalidate(kind, scope) {
      // Throw on failure: callers doing durable invalidation must retry before inbox completion.
      await redis.execute((client) =>
        client.set(generationKey(kind, scope), randomUUID()),
      );
      metrics?.increment(`cache.${kind}.invalidated`);
    },
    async read({ kind, scope, query = {}, ttlSeconds, load, validate }) {
      let generation;
      let key;
      const genKey = generationKey(kind, scope);
      if (enabled) {
        try {
          generation = await redis.execute((client) =>
            client.eval(GENERATION, 1, genKey, randomUUID()),
          );
          key = dataKey(kind, scope, generation, query);
          const value = await readValue(key, validate, kind);
          if (value !== undefined) {
            metrics?.increment(`cache.${kind}.hit`);
            return clone(value);
          }
        } catch {
          metrics?.increment(`cache.${kind}.redis_error`);
          key = undefined;
        }
      }
      metrics?.increment(`cache.${kind}.${key ? "miss" : "bypass"}`);
      const flightKey = key || `${kind}:${scope}:${hashQuery(query)}`;
      if (!flights.has(flightKey)) {
        if (flights.size >= 1000)
          throw new AppError(503, "CATALOG_BUSY", "Catalog đang quá tải.");
        const pending = (async () => {
          const token = randomUUID();
          const leaseKey =
            key && `${namespace}:lock:cache-fill:${hashQuery(key)}`;
          let ownsLease = false;
          let canFill = Boolean(key);
          try {
            if (key) {
              try {
                ownsLease = Boolean(
                  await redis.execute((client) =>
                    client.set(leaseKey, token, "NX", "EX", 2),
                  ),
                );
                if (!ownsLease) {
                  await delay(50 + Math.floor(random() * 51));
                  const value = await readValue(key, validate, kind);
                  if (value !== undefined) {
                    metrics?.increment(`cache.${kind}.wait_hit`);
                    return value;
                  }
                  // A losing waiter may read source, but should not race the lease owner to refill.
                  canFill = false;
                }
              } catch {
                canFill = false;
              }
            }
            const started = Date.now();
            metrics?.increment(`cache.${kind}.source_calls`);
            const value = await sourceGate(load);
            metrics?.increment(`cache.${kind}.source_ms`, Date.now() - started);
            if (!validate(value))
              throw new Error("Invalid public cache DTO from source");
            if (canFill) {
              try {
                const ttlMs = Math.max(
                  1,
                  Math.round(ttlSeconds * 1000 * (0.8 + random() * 0.4)),
                );
                const saved = await redis.execute((client) =>
                  client.eval(
                    FILL,
                    2,
                    genKey,
                    key,
                    generation,
                    JSON.stringify(value),
                    ttlMs,
                  ),
                );
                if (!saved)
                  metrics?.increment(`cache.${kind}.stale_fill_prevented`);
              } catch {
                metrics?.increment(`cache.${kind}.fill_error`);
              }
            }
            return value;
          } finally {
            if (ownsLease) {
              await redis
                .execute((client) => client.eval(RELEASE, 1, leaseKey, token))
                .catch(() => {});
            }
          }
        })();
        flights.set(flightKey, pending);
        pending.finally(() => flights.delete(flightKey)).catch(() => {});
      } else {
        metrics?.increment(`cache.${kind}.coalesced`);
      }
      return clone(await flights.get(flightKey));
    },
  };
}

module.exports = {
  createPublicCache,
  createSourceGate,
  hashQuery,
  stableJson,
  GENERATION,
  FILL,
};
