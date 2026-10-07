const { randomUUID } = require("node:crypto");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const {
  createBookingService,
} = require("../../src/modules/bookings/booking.service");
const {
  createBookingRepository,
} = require("../../src/modules/bookings/booking.repository");
const {
  createAvailabilityService,
} = require("../../src/modules/availability/availability.service");
const {
  createAvailabilityRepository,
} = require("../../src/modules/availability/availability.repository");
const { createBookingLock } = require("../../src/infrastructure/redis/lock");
const { testRedis } = require("../helpers/redis");
const { bookingFixture } = require("../helpers/booking-fixture");

describe("Redis booking command with PostgreSQL guards", () => {
  const env = getEnv();
  let ctx, fixture, availabilityService;
  const repository = createBookingRepository(db);
  function service(
    redis = ctx.redis,
    customRepository = repository,
    customLock,
  ) {
    return createBookingService({
      db,
      repository: customRepository,
      availabilityService,
      env,
      bookingLock:
        customLock || createBookingLock({ redis, namespace: ctx.namespace }),
    });
  }
  beforeAll(async () => {
    ctx = await testRedis(env.redisUrl);
    fixture = await bookingFixture(db, env);
    availabilityService = createAvailabilityService({
      repository: createAvailabilityRepository(db),
      env,
    });
  });
  afterAll(async () => {
    if (fixture) await fixture.cleanup();
    if (ctx) await ctx.cleanup();
    await closeDatabase();
  });

  it("100 contenders have exactly one winner, and no Redis lease remains while PENDING", async () => {
    const booking = service();
    const requests = Array.from({ length: 100 }, (_, index) => ({
      user: fixture.users[index % 2],
      key: randomUUID(),
    }));
    const results = await Promise.allSettled(
      requests.map(({ user, key }) => booking.create(user, key, fixture.body)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) =>
          ["BOOKING_IN_PROGRESS", "ROOM_UNAVAILABLE"].includes(r.reason.code),
        ),
    ).toBe(true);
    const winner = winners[0].value.booking;
    expect(winner.status).toBe("PENDING_PAYMENT");
    expect(
      await ctx.redis.client.exists(
        `${ctx.namespace}:lock:booking:room-type:${fixture.roomTypeId}`,
      ),
    ).toBe(0);
    const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
    expect(
      (
        await booking.create(
          requests[winnerIndex].user,
          requests[winnerIndex].key,
          fixture.body,
        )
      ).booking.id,
    ).toBe(winner.id);
    expect(
      await db("room_availability").where({ booking_id: winner.id }),
    ).toHaveLength(2);
    await booking.cancel(requests[winnerIndex].user, winner.id, "test cleanup");
  }, 15000);

  it("Redis down still gives one DB winner; row-count failure rolls everything back", async () => {
    const unavailable = {
      execute: async () => {
        throw new Error("down");
      },
    };
    const booking = service(unavailable);
    const results = await Promise.allSettled(
      fixture.users.map((user) =>
        booking.create(user, randomUUID(), fixture.body),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe(
      "ROOM_UNAVAILABLE",
    );
    const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
    await booking.cancel(
      fixture.users[winnerIndex],
      results[winnerIndex].value.booking.id,
      "test cleanup",
    );
    const key = randomUUID();
    const broken = service(ctx.redis, {
      ...repository,
      holdAvailability: async () => 0,
    });
    await expect(
      broken.create(fixture.users[0], key, fixture.body),
    ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(await db("bookings").where({ idempotency_key: key })).toHaveLength(
      0,
    );
    expect(
      await ctx.redis.client.exists(
        `${ctx.namespace}:lock:booking:room-type:${fixture.roomTypeId}`,
      ),
    ).toBe(0);
  });

  it("lease loss during a transaction cannot allow two database winners", async () => {
    const lock = createBookingLock(ctx);
    const loseLease = {
      async acquire(id) {
        const release = await lock.acquire(id);
        // Simulate expiration/failover before both transactions contend in PG.
        await ctx.redis.client.del(
          `${ctx.namespace}:lock:booking:room-type:${id}`,
        );
        return release;
      },
    };
    const booking = service(ctx.redis, repository, loseLease);
    const results = await Promise.allSettled(
      fixture.users.map((user) =>
        booking.create(user, randomUUID(), fixture.body),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
    await booking.cancel(
      fixture.users[winnerIndex],
      results[winnerIndex].value.booking.id,
      "test cleanup",
    );
  });

  it("app role has DML but no DDL or replication privileges", async () => {
    const result = await db.raw(
      "SELECT current_user AS name, has_schema_privilege(current_user, 'public', 'CREATE') AS ddl, rolsuper, rolreplication FROM pg_roles WHERE rolname = current_user",
    );
    expect(result.rows[0]).toEqual({
      name: "hotel_booking_app",
      ddl: false,
      rolsuper: false,
      rolreplication: false,
    });
  });
});
