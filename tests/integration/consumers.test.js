const { randomUUID } = require("node:crypto");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const { bookingFixture } = require("../helpers/booking-fixture");
const { createDomainServices } = require("../../src/runtime/domain-services");
const {
  createInboxRepository,
} = require("../../src/modules/events/inbox.repository");
const { createEnvelope } = require("../../src/modules/events/event-envelope");
const {
  createNotificationConsumer,
} = require("../../src/workers/notification-consumer");
const {
  createCacheInvalidator,
} = require("../../src/workers/cache-invalidator");
const {
  createNotificationSender,
} = require("../../src/workers/notification-sender");
const {
  startSchedulerRuntime,
} = require("../../src/runtime/scheduler-runtime");
const { replayEvent } = require("../../src/modules/events/replay");

describe("durable consumer effects and notification leases", () => {
  const env = getEnv(),
    inbox = createInboxRepository(db),
    ids = [];
  let fixture, booking;
  const notification = createNotificationConsumer({ inbox });
  function event(type = "BookingHeld") {
    const value = createEnvelope({
      aggregateType: "booking",
      aggregateId: booking.id,
      version: ids.length + 1,
      eventType: type,
      requestId: "one-request-many-events",
      data: { booking_id: booking.id, user_id: booking.user_id },
    });
    ids.push(value.event_id);
    return value;
  }
  beforeAll(async () => {
    fixture = await bookingFixture(db, env);
    ({ booking } = await createDomainServices({
      db,
      env: { ...env, outboxEnabled: false },
    }).bookingService.create(fixture.users[0], randomUUID(), fixture.body));
    // API DTO does not expose internal user_id.
    booking = await db("bookings").where({ id: booking.id }).first();
  });
  afterEach(async () => {
    await db("notification_jobs").whereIn("event_id", ids).del();
    await db("consumer_inbox").whereIn("event_id", ids).del();
  });
  afterAll(async () => {
    if (fixture) await fixture.cleanup();
    await closeDatabase();
  });
  it("two workers and redelivery after DB commit create one logical job", async () => {
    const one = event();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => notification.handle(one)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await notification.handle(one)).duplicate).toBe(true);
    expect(
      await db("notification_jobs").where({ event_id: one.event_id }),
    ).toHaveLength(1);
    const two = event("BookingConfirmed");
    await notification.handle(two);
    expect(
      await db("notification_jobs").whereIn("event_id", [
        one.event_id,
        two.event_id,
      ]),
    ).toHaveLength(2);
  });
  it("rolls inbox back with a failed DB effect, then retries successfully", async () => {
    const one = event();
    await expect(
      inbox.transaction("test-rollback", one.event_id, async (trx) => {
        await trx("notification_jobs").insert({
          event_id: one.event_id,
          template: "rollback",
          recipient_ref: booking.user_id,
          booking_id: booking.id,
        });
        throw new Error("rollback-effect");
      }),
    ).rejects.toThrow("rollback-effect");
    expect(
      await db("consumer_inbox").where({ event_id: one.event_id }),
    ).toHaveLength(0);
    expect(
      await db("notification_jobs").where({ event_id: one.event_id }),
    ).toHaveLength(0);
    expect((await notification.handle(one)).duplicate).toBe(false);
  });
  it("does not send another confirmation from PaymentSucceeded", async () => {
    const one = event("PaymentSucceeded");
    await notification.handle(one);
    expect(
      await db("notification_jobs").where({ event_id: one.event_id }),
    ).toHaveLength(0);
  });
  it("Redis invalidation failure leaves inbox incomplete; retry repeats safely, never touches search:es", async () => {
    const one = createEnvelope({
      aggregateType: "catalog",
      aggregateId: fixture.propertyId,
      version: 1,
      eventType: "PropertyUpserted",
      data: { property_id: fixture.propertyId },
    });
    ids.push(one.event_id);
    const calls = [],
      cache = {
        invalidate: async (kind, scope) => {
          calls.push([kind, scope]);
          if (calls.length === 2) throw new Error("Redis unavailable");
        },
      };
    const handler = createCacheInvalidator({ inbox, cache });
    await expect(handler.handle(one)).rejects.toThrow("Redis unavailable");
    expect(
      await db("consumer_inbox").where({ event_id: one.event_id }),
    ).toHaveLength(0);
    await handler.handle(one);
    const before = calls.length;
    await handler.handle(one);
    expect(calls.length).toBe(before);
    expect(calls).not.toContainEqual(["search", "es"]);
    expect(calls.filter(([kind]) => kind === "property")).toHaveLength(2);
  });
  it("concurrent senders claim only once and mark SENT after the sink", async () => {
    const one = event();
    await notification.handle(one);
    const transport = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = createNotificationSender({ db, transport });
    await Promise.all([sender.tick(), sender.tick()]);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const row = await db("notification_jobs")
      .where({ event_id: one.event_id })
      .first();
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(1);
    expect(transport.send.mock.calls[0][0].idempotencyKey).toBe(row.id);
  });
  it("send success then crash before SENT is UNKNOWN after lease, not automatic resend", async () => {
    const one = event();
    await notification.handle(one);
    const job = await db("notification_jobs")
      .where({ event_id: one.event_id })
      .first();
    await db("notification_jobs")
      .where({ id: job.id })
      .update({
        status: "SENDING",
        attempts: 1,
        lock_token: randomUUID(),
        locked_until: new Date(Date.now() - 1000),
      });
    const transport = { send: vi.fn() };
    await createNotificationSender({ db, transport }).tick();
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      (await db("notification_jobs").where({ id: job.id }).first()).status,
    ).toBe("UNKNOWN");
  });
  it("retries only known-not-sent failures; uncertain delivery goes to manual review", async () => {
    const one = event();
    await notification.handle(one);
    const definite = new Error("rejected before send");
    definite.definitelyNotSent = true;
    const transport = {
      send: vi
        .fn()
        .mockRejectedValueOnce(definite)
        .mockRejectedValueOnce(new Error("connection reset after send")),
    };
    const sender = createNotificationSender({ db, transport });
    await sender.tick();
    expect(
      (await db("notification_jobs").where({ event_id: one.event_id }).first())
        .status,
    ).toBe("FAILED");
    await db("notification_jobs")
      .where({ event_id: one.event_id })
      .update({ available_at: db.fn.now() });
    await sender.tick();
    await sender.tick();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(
      (await db("notification_jobs").where({ event_id: one.event_id }).first())
        .status,
    ).toBe("UNKNOWN");
  });
  it("refuses two scheduler processes and drains jobs before releasing singleton", async () => {
    const services = {
      paymentService: { reconcileExpiredBatch: vi.fn().mockResolvedValue([]) },
      availabilityService: { extendWindow: vi.fn().mockResolvedValue({}) },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const first = await startSchedulerRuntime({ db, env, services, logger });
    try {
      await expect(
        startSchedulerRuntime({ db, env, services, logger }),
      ).rejects.toThrow("SCHEDULER_ALREADY_RUNNING");
    } finally {
      await first.stop();
    }
    const next = await startSchedulerRuntime({ db, env, services, logger });
    await next.stop();
  });
  it("replay requires explicit target/confirmation and refuses historical email by default", async () => {
    const one = event(),
      handlers = { notification };
    await expect(
      replayEvent({
        db,
        handlers,
        eventId: one.event_id,
        consumerName: notification.name,
      }),
    ).rejects.toThrow("REPLAY_REQUIRES");
    await expect(
      replayEvent({
        db,
        handlers,
        confirm: true,
        eventId: one.event_id,
        consumerName: notification.name,
      }),
    ).rejects.toThrow("NOTIFICATION_REPLAY_REQUIRES");
    await expect(
      replayEvent({
        db,
        handlers,
        confirm: true,
        eventId: one.event_id,
        consumerName: "arbitrary-handler",
      }),
    ).rejects.toThrow("REPLAY_HANDLER_NOT_ALLOWED");
  });
});
