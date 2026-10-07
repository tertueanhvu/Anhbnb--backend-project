const { randomUUID, createHmac } = require("node:crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const { createApiRouter } = require("../../src/routes");
const { createApp } = require("../../src/app");
const { testRedis } = require("../helpers/redis");
const { bookingFixture } = require("../helpers/booking-fixture");

describe("public cache API and payment compatibility", () => {
  const baseEnv = getEnv();
  let ctx, fixture, router, app, tokens, env;
  beforeAll(async () => {
    ctx = await testRedis(baseEnv.redisUrl);
    fixture = await bookingFixture(db, baseEnv);
    env = {
      ...baseEnv,
      redisNamespace: ctx.namespace,
      rateLimit: { ...baseEnv.rateLimit, commandUser: 1 },
    };
    router = createApiRouter({ env });
    app = createApp({ apiRouter: router });
    tokens = fixture.users.map((id, index) =>
      jwt.sign({ id, email: fixture.emails[index] }, env.jwtSecret, {
        expiresIn: "1h",
      }),
    );
    // Ensure these are actual Redis hits, not only local fallback during connect.
    await new Promise((resolve) =>
      router.runtimeServices.redis.client.status === "ready"
        ? resolve()
        : router.runtimeServices.redis.client.once("ready", resolve),
    );
  });
  afterAll(async () => {
    router?.close();
    if (fixture) await fixture.cleanup();
    if (ctx) await ctx.cleanup();
    await closeDatabase();
  });

  it("detail/reference/search cache share public DTOs, with different page keys", async () => {
    for (const path of [
      `/properties/${fixture.propertyId}`,
      "/amenities",
      "/locations",
      "/properties?page=1",
      "/properties?page=2",
    ]) {
      const a = await request(app)
        .get(`/api/v1${path}`)
        .set("Authorization", `Bearer ${tokens[0]}`);
      const b = await request(app)
        .get(`/api/v1${path}`)
        .set("Authorization", `Bearer ${tokens[1]}`);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(b.body.data).toEqual(a.body.data);
      expect(JSON.stringify(b.body)).not.toContain(fixture.emails[0]);
      expect(JSON.stringify(b.body)).not.toContain("password_hash");
    }
    const metrics = router.runtimeServices.metrics.snapshot();
    expect(metrics["cache.property.hit"]).toBeGreaterThan(0);
    expect(metrics["cache.reference.hit"]).toBeGreaterThan(0);
    expect(metrics["cache.search.hit"]).toBeGreaterThan(0);
  });

  it("warm dated search immediately reflects a booking; callback retries are not user-rate-limited", async () => {
    const query = {
      city: "Redis Test City",
      checkIn: fixture.checkIn,
      checkOut: fixture.checkOut,
      roomQuantity: 1,
      adults: 2,
      children: 0,
    };
    const before = await request(app).get("/api/v1/properties").query(query);
    expect(before.status).toBe(200);
    expect(before.body.data.some((p) => p.id === fixture.propertyId)).toBe(
      true,
    );
    const booking = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokens[0]}`)
      .set("Idempotency-Key", randomUUID())
      .send(fixture.body);
    expect(booking.status, JSON.stringify(booking.body)).toBe(201);
    const after = await request(app).get("/api/v1/properties").query(query);
    expect(after.body.data.some((p) => p.id === fixture.propertyId)).toBe(
      false,
    );
    const detail = await request(app)
      .get(`/api/v1/properties/${fixture.propertyId}`)
      .query({ ...query, city: undefined });
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data.roomTypes[0].available).toBe(false);
    const plain = await request(app).get(
      `/api/v1/properties/${fixture.propertyId}`,
    );
    expect(plain.body.data.roomTypes[0]).not.toHaveProperty("available");
    const payment = await request(app)
      .post(`/api/v1/bookings/${booking.body.data.id}/payments`)
      .set("Authorization", `Bearer ${tokens[0]}`)
      .send({ provider: "ZALOPAY" });
    expect(payment.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/v1/bookings/${booking.body.data.id}/payments`)
          .set("Authorization", `Bearer ${tokens[0]}`)
          .send({ provider: "ZALOPAY" })
      ).status,
    ).toBe(429);
    const row = await db("payments")
      .where({ id: payment.body.data.id })
      .first();
    const data = JSON.stringify({
      app_id: "MOCK",
      app_trans_id: row.app_trans_id,
      amount: Number(row.amount),
      zp_trans_id: randomUUID(),
      server_time: Date.now(),
    });
    const mac = createHmac("sha256", env.zalopay.key2 || "mock-callback-key")
      .update(data)
      .digest("hex");
    for (let i = 0; i < 40; i += 1) {
      const callback = await request(app)
        .post("/api/v1/payments/zalopay/callback")
        .send({ data, mac });
      expect(callback.status).toBe(200);
      expect(callback.body.return_code).toBe(1);
    }
    expect(
      (await db("bookings").where({ id: booking.body.data.id }).first()).status,
    ).toBe("CONFIRMED");
    expect(
      await db("payments").where({ booking_id: booking.body.data.id }),
    ).toHaveLength(1);
  });

  it("catalog source is read after invalidation, and Redis down still serves public reads", async () => {
    await db("properties")
      .where({ id: fixture.propertyId })
      .update({ name: "Updated Redis Test Hotel" });
    await router.runtimeServices.cache.invalidate(
      "property",
      fixture.propertyId,
    );
    const changed = await request(app).get(
      `/api/v1/properties/${fixture.propertyId}`,
    );
    expect(changed.body.data.name).toBe("Updated Redis Test Hotel");
    router.runtimeServices.redis.close();
    for (const path of [
      `/properties/${fixture.propertyId}`,
      "/amenities",
      "/locations",
      "/properties",
    ]) {
      const result = await request(app).get(`/api/v1${path}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
  });
});
