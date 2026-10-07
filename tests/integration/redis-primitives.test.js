const { getEnv } = require("../../src/config/env");
const { testRedis } = require("../helpers/redis");
const { createBookingLock } = require("../../src/infrastructure/redis/lock");
const {
  createRateLimitStore,
} = require("../../src/infrastructure/redis/rate-limit");
const { createPublicCache } = require("../../src/infrastructure/redis/cache");
const { createMetrics } = require("../../src/infrastructure/metrics");

describe("Redis real-server primitives", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await testRedis(getEnv().redisUrl);
  });
  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("stale owner cannot delete a replacement lease; contention expires", async () => {
    const lock = createBookingLock({ ...ctx, retryCount: 0 });
    const release = await lock.acquire("one");
    const key = `${ctx.namespace}:lock:booking:room-type:one`;
    expect(await ctx.redis.client.ttl(key)).toBeGreaterThan(0);
    await expect(lock.acquire("one")).rejects.toMatchObject({
      code: "BOOKING_IN_PROGRESS",
    });
    // Model lease expiration followed by a different owner atomically acquiring it.
    await ctx.redis.client.set(key, "new-owner", "EX", 10);
    await release();
    expect(await ctx.redis.client.get(key)).toBe("new-owner");
  });

  it("shares atomic counters across two stores and every bucket has TTL", async () => {
    const a = createRateLimitStore(ctx);
    const b = createRateLimitStore(ctx);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 ? a : b).hit("test", "subject", 60000),
      ),
    );
    expect(Math.max(...results.map((r) => r.count))).toBe(40);
    expect(results.every((r) => !r.degraded)).toBe(true);
    const [, keys] = await ctx.redis.client.scan(
      "0",
      "MATCH",
      `${ctx.namespace}:rl:*`,
      "COUNT",
      100,
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys)
      expect(await ctx.redis.client.pttl(key)).toBeGreaterThan(0);
  });

  it("caches with jitter, coalesces fills, and refuses a fill racing invalidation", async () => {
    const metrics = createMetrics();
    const cache = createPublicCache({ ...ctx, metrics, random: () => 0.5 });
    const options = {
      kind: "search",
      scope: "pg",
      query: { page: 1 },
      ttlSeconds: 30,
      validate: Array.isArray,
    };
    let loaded;
    let finish;
    const begun = new Promise((resolve) => {
      loaded = resolve;
    });
    const load = vi.fn(() => {
      loaded();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const inFlight = cache.read({ ...options, load });
    await begun;
    await cache.invalidate("search", "pg");
    finish(["old"]);
    expect(await inFlight).toEqual(["old"]);
    expect(metrics.snapshot()["cache.search.stale_fill_prevented"]).toBe(1);
    const fresh = vi.fn(async () => ["new"]);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        cache.read({ ...options, load: fresh }),
      ),
    );
    expect(results.every((value) => value[0] === "new")).toBe(true);
    expect(fresh).toHaveBeenCalledTimes(1);
    const gen = await ctx.redis.client.get(cache.generationKey("search", "pg"));
    const key = cache.dataKey("search", "pg", gen, options.query);
    expect(await ctx.redis.client.pttl(key)).toBeGreaterThan(24000);
    expect(await ctx.redis.client.pttl(key)).toBeLessThanOrEqual(36000);
    expect(
      await ctx.redis.client.ttl(cache.generationKey("search", "pg")),
    ).toBe(-1);
    await cache.read({ ...options, load: fresh });
    expect(fresh).toHaveBeenCalledTimes(1);
    await ctx.redis.client.del(cache.generationKey("search", "pg"));
    expect(
      await cache.read({
        ...options,
        load: async () => ["after-generation-loss"],
      }),
    ).toEqual(["after-generation-loss"]);
  });

  it("ignores malformed cached DTO and requires retry when invalidation fails", async () => {
    const cache = createPublicCache(ctx);
    const options = {
      kind: "reference",
      scope: "amenities",
      ttlSeconds: 3600,
      validate: Array.isArray,
      load: async () => ["ok"],
    };
    await cache.read(options);
    const gen = await ctx.redis.client.get(
      cache.generationKey("reference", "amenities"),
    );
    const key = cache.dataKey("reference", "amenities", gen, {});
    await ctx.redis.client.set(key, '{"token":"private"}');
    expect(await cache.read(options)).toEqual(["ok"]);
    const down = createPublicCache({
      namespace: ctx.namespace,
      redis: {
        execute: async () => {
          throw new Error("down");
        },
      },
    });
    await expect(down.invalidate("search", "pg")).rejects.toThrow("down");
  });
});
