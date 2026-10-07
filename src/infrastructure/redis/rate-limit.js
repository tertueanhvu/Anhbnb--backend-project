const WINDOW = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local start = now - (now % window)
local key = KEYS[1] .. ':' .. start
local count = redis.call('INCR', key)
local remaining = window - (now % window)
if count == 1 then redis.call('PEXPIRE', key, remaining + 1000) end
return {count, remaining}`;

function createRateLimitStore({
  redis,
  namespace,
  maxSubjects = 10000,
  metrics,
  clock = Date.now,
}) {
  const local = new Map();
  const overflow = new Map();
  function fallback(policy, subject, windowMs) {
    const now = clock();
    const windowStart = now - (now % windowMs);
    const key = `${policy}:${subject}:${windowStart}`;
    if (local.size >= maxSubjects) {
      for (const [candidate, value] of local) {
        if (value.expiresAt <= now) local.delete(candidate);
      }
    }
    let store = local;
    let storeKey = key;
    if (!local.has(key) && local.size >= maxSubjects) {
      // Do not evict a live subject and silently reset its quota.
      store = overflow;
      storeKey = policy;
      metrics?.increment("rate_limit.overflow");
    }
    let entry = store.get(storeKey);
    if (!entry || entry.expiresAt <= now)
      entry = { count: 0, expiresAt: windowStart + windowMs };
    entry.count += 1;
    store.set(storeKey, entry);
    return [entry.count, entry.expiresAt - now];
  }

  return {
    async hit(policy, subject, windowMs) {
      try {
        const [count, remaining] = await redis.execute((client) =>
          client.eval(
            WINDOW,
            1,
            `${namespace}:rl:v1:${policy}:${subject}`,
            windowMs,
          ),
        );
        return {
          count,
          retryAfter: Math.max(1, Math.ceil(remaining / 1000)),
          degraded: false,
        };
      } catch {
        metrics?.increment("rate_limit.local_fallback");
        const [count, remaining] = fallback(policy, subject, windowMs);
        return {
          count,
          retryAfter: Math.max(1, Math.ceil(remaining / 1000)),
          degraded: true,
        };
      }
    },
    localSize: () => local.size,
  };
}

module.exports = { createRateLimitStore, WINDOW };
