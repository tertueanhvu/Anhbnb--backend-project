const express = require("express");
const request = require("supertest");
const {
  createRateLimitStore,
} = require("../../src/infrastructure/redis/rate-limit");
const { createRateLimiters } = require("../../src/middlewares/rate-limit");
const { errorHandler } = require("../../src/middlewares/error-handler");
const { createMetrics } = require("../../src/infrastructure/metrics");
const unavailable = {
  execute: async () => {
    throw new Error("down");
  },
};
const env = {
  redisNamespace: "test",
  rateLimitKeySecret: "a".repeat(32),
  rateLimit: {
    loginIp: 3,
    loginAccount: 2,
    registerIp: 2,
    authWindowMs: 1000,
    search: 2,
    searchWindowMs: 1000,
    commandIp: 3,
    commandUser: 2,
    commandWindowMs: 1000,
    webhookSoft: 1,
  },
};

describe("distributed limiter fallback", () => {
  it("keeps bounded subject storage and an overflow quota, then resets at window boundary", async () => {
    let now = 1000;
    const store = createRateLimitStore({
      redis: unavailable,
      namespace: "test",
      maxSubjects: 1,
      clock: () => now,
    });
    expect((await store.hit("login", "a", 1000)).count).toBe(1);
    expect((await store.hit("login", "b", 1000)).count).toBe(1);
    expect((await store.hit("login", "c", 1000)).count).toBe(2);
    expect(store.localSize()).toBe(1);
    now += 1000;
    expect((await store.hit("login", "c", 1000)).count).toBe(1);
  });

  it("uses atomic Redis TIME/INCR script with no raw subject", async () => {
    const client = { eval: vi.fn().mockResolvedValue([2, 4500]) };
    const store = createRateLimitStore({
      redis: { execute: (fn) => fn(client) },
      namespace: "test",
    });
    expect(await store.hit("search", "hashed-id", 60000)).toEqual({
      count: 2,
      retryAfter: 5,
      degraded: false,
    });
    expect(client.eval.mock.calls[0][0]).toContain("redis.call('TIME')");
    expect(client.eval.mock.calls[0][2]).toBe("test:rl:v1:search:hashed-id");
  });

  it("returns 429/Retry-After and ignores spoofed forwarded IP with direct trust", async () => {
    const app = express();
    app.set("trust proxy", false);
    const limiters = createRateLimiters({
      redis: unavailable,
      env: { ...env, rateLimit: { ...env.rateLimit, searchWindowMs: 60000 } },
    });
    app.get("/search", limiters.search, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    expect(
      (await request(app).get("/search").set("X-Forwarded-For", "1.1.1.1"))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get("/search").set("X-Forwarded-For", "2.2.2.2"))
        .status,
    ).toBe(200);
    const limited = await request(app)
      .get("/search")
      .set("X-Forwarded-For", "3.3.3.3");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("uses verified users, HMAC account keys, IPv6 /64, and non-blocking webhook meter", async () => {
    const keys = [];
    const redis = {
      execute: (fn) =>
        fn({
          eval: async (_script, _n, key) => {
            keys.push(key);
            return [2, 60000];
          },
        }),
    };
    const metrics = createMetrics();
    const limits = createRateLimiters({ redis, env, metrics });
    const res = { set: () => {} };
    const next = vi.fn();
    const req = {
      ip: "2001:db8:abcd:1::1",
      auth: { id: "verified-user" },
      body: { email: "PRIVATE@EXAMPLE.COM" },
    };
    await limits.login(req, res, next);
    await limits.search(req, res, next);
    await limits.search({ ...req, ip: "2001:db8:abcd:1::2" }, res, next);
    expect(keys[2]).toBe(keys[4]);
    expect(keys[3]).toBe(keys[5]);
    expect(keys.join(" ")).not.toContain("PRIVATE");
    expect(keys.join(" ")).not.toContain("verified-user");
    await expect(limits.meterWebhook("app")).resolves.toBeUndefined();
    expect(metrics.snapshot()["webhook.soft_limit_exceeded"]).toBe(1);
  });
});
