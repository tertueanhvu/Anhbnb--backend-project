const { randomUUID } = require("node:crypto");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const {
  createOutboxRepository,
} = require("../../src/modules/events/outbox.repository");
const {
  createBookingRepository,
} = require("../../src/modules/bookings/booking.repository");
const {
  createBookingService,
} = require("../../src/modules/bookings/booking.service");
const {
  createPaymentRepository,
} = require("../../src/modules/payments/payment.repository");
const {
  createPaymentService,
} = require("../../src/modules/payments/payment.service");
const {
  createMockPaymentProvider,
} = require("../../src/modules/payments/providers/mock-payment.provider");
const {
  createAvailabilityRepository,
} = require("../../src/modules/availability/availability.repository");
const {
  createAvailabilityService,
} = require("../../src/modules/availability/availability.service");
const {
  createCatalogWriteService,
} = require("../../src/modules/catalog/catalog-write.service");
const { eventContext } = require("../../src/modules/events/event-context");
const { bookingFixture } = require("../helpers/booking-fixture");

describe("atomic outbox across booking, payment and catalog", () => {
  const env = getEnv(),
    outbox = createOutboxRepository();
  const bookingRepository = createBookingRepository(db, { outbox });
  const paymentRepository = createPaymentRepository(db, { outbox });
  const availabilityService = createAvailabilityService({
    repository: createAvailabilityRepository(db),
    env,
  });
  const bookingService = createBookingService({
    db,
    repository: bookingRepository,
    availabilityService,
    env,
  });
  const provider = createMockPaymentProvider();
  const paymentService = createPaymentService({
    db,
    repository: paymentRepository,
    bookingRepository,
    provider,
    env,
  });
  let fixture;
  const eventIds = new Set();
  beforeAll(async () => {
    fixture = await bookingFixture(db, env);
  });
  afterAll(async () => {
    if (fixture) {
      const bookings = await db("bookings")
        .whereIn("user_id", fixture.users)
        .pluck("id");
      const payments = await db("payments")
        .whereIn("booking_id", bookings)
        .pluck("id");
      await db("outbox_events")
        .whereIn("aggregate_id", [
          ...bookings,
          ...payments,
          fixture.propertyId,
          ...eventIds,
        ])
        .del();
      await db("catalog_versions")
        .where({ property_id: fixture.propertyId })
        .del();
      await fixture.cleanup();
    }
    await closeDatabase();
  });
  async function events(id) {
    return db("outbox_events")
      .where({ aggregate_id: id })
      .orderBy("aggregate_version");
  }

  it("business failure rolls back both booking and its already-inserted outbox row", async () => {
    const broken = createBookingService({
      db,
      repository: { ...bookingRepository, holdAvailability: async () => 0 },
      availabilityService,
      env,
    });
    const before = await db("outbox_events").count("* as count").first();
    await expect(
      broken.create(fixture.users[0], randomUUID(), fixture.body),
    ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(await db("outbox_events").count("* as count").first()).toEqual(
      before,
    );
    expect(await db("bookings").whereIn("user_id", fixture.users)).toHaveLength(
      0,
    );
    const failedOutbox = createBookingRepository(db, {
      outbox: {
        transition: async () => {
          throw new Error("event insert failed");
        },
      },
    });
    const failedService = createBookingService({
      db,
      repository: failedOutbox,
      availabilityService,
      env,
    });
    await expect(
      failedService.create(fixture.users[0], randomUUID(), fixture.body),
    ).rejects.toThrow("event insert failed");
    expect(await db("bookings").whereIn("user_id", fixture.users)).toHaveLength(
      0,
    );
  });

  it("idempotent booking and cancel emit one event per real state transition", async () => {
    const key = randomUUID();
    const { booking } = await eventContext.run(
      { requestId: "same-request" },
      () => bookingService.create(fixture.users[0], key, fixture.body),
    );
    await bookingService.create(fixture.users[0], key, fixture.body);
    await eventContext.run({ requestId: "same-request" }, () =>
      bookingService.cancel(fixture.users[0], booking.id, "test"),
    );
    await bookingService.cancel(fixture.users[0], booking.id, "duplicate");
    const rows = await events(booking.id);
    expect(rows.map((r) => r.event_type)).toEqual([
      "BookingHeld",
      "BookingCancelled",
    ]);
    expect(rows.map((r) => Number(r.aggregate_version))).toEqual([1, 2]);
    expect(rows[0].request_id).toBe(rows[1].request_id);
    expect(rows[0].event_id).not.toBe(rows[1].event_id);
    expect(rows[0].payload.event_id).toBe(rows[0].event_id);
  });

  it("expiry is atomic for booking/payment, duplicate expiry is a no-op, and late success is preserved", async () => {
    const { booking } = await bookingService.create(
      fixture.users[0],
      randomUUID(),
      fixture.body,
    );
    const { payment } = await paymentService.create(
      fixture.users[0],
      booking.id,
    );
    await db("bookings")
      .where({ id: booking.id })
      .update({ hold_expires_at: new Date(Date.now() - 120000) });
    await db.transaction((trx) =>
      bookingRepository.expireHeldBookings([booking.id], new Date(), trx),
    );
    await db.transaction((trx) =>
      bookingRepository.expireHeldBookings([booking.id], new Date(), trx),
    );
    expect((await events(booking.id)).map((r) => r.event_type)).toEqual([
      "BookingHeld",
      "BookingExpired",
    ]);
    expect((await events(payment.id)).map((r) => r.event_type)).toEqual([
      "PaymentCreated",
      "PaymentPending",
      "PaymentExpired",
    ]);
    const success = {
      paymentId: payment.id,
      appId: "MOCK",
      amount: payment.amount,
      providerTransId: randomUUID(),
    };
    await eventContext.run({ requestId: "late-success" }, () =>
      paymentService.applySuccess(success),
    );
    await paymentService.applySuccess(success);
    const payEvents = await events(payment.id),
      bookingEvents = await events(booking.id);
    expect(
      payEvents.filter((r) => r.event_type === "PaymentSucceeded"),
    ).toHaveLength(1);
    expect(
      bookingEvents.filter((r) => r.event_type === "BookingConfirmed"),
    ).toHaveLength(1);
    expect(payEvents.at(-1).request_id).toBe(bookingEvents.at(-1).request_id);
    expect(payEvents.at(-1).payload.data.manual_refund_required).toBe(false);
    // Preserve the confirmed fixture; later tests operate only on metadata.
  });

  it("uses one monotonic full-property revision and rolls catalog mutation back on outbox failure", async () => {
    const catalog = createCatalogWriteService({
      db,
      outbox,
      cache: {
        invalidate: async () => {
          throw new Error("Redis down");
        },
      },
    });
    const first = await catalog.updateProperty(fixture.propertyId, {
      name: "Atomic Catalog",
    });
    const second = await catalog.updateRoomType(fixture.roomTypeId, {
      name: "Updated type",
    });
    expect(second.aggregate_version).toBe(first.aggregate_version + 1);
    expect(second.aggregate_id).toBe(fixture.propertyId);
    expect(second.data.snapshot.roomTypes[0].name).toBe("Updated type");
    const broken = createCatalogWriteService({
      db,
      outbox: {
        append: async () => {
          throw new Error("outbox fail");
        },
      },
    });
    await expect(
      broken.updateProperty(fixture.propertyId, { name: "Must rollback" }),
    ).rejects.toThrow("outbox fail");
    expect(
      (await db("properties").where({ id: fixture.propertyId }).first()).name,
    ).toBe("Atomic Catalog");
    expect(
      Number(
        (
          await db("catalog_versions")
            .where({ property_id: fixture.propertyId })
            .first()
        ).version,
      ),
    ).toBe(second.aggregate_version);
    await expect(
      catalog.deleteProperty(fixture.propertyId),
    ).rejects.toMatchObject({ code: "PROPERTY_HAS_BOOKINGS" });
  });

  it("preserves a delete tombstone and rejects UUID resurrection", async () => {
    const id = randomUUID();
    eventIds.add(id);
    await db("properties").insert({
      id,
      name: "Disposable catalog",
      slug: id,
      address_line: "test",
      city: "test",
    });
    const catalog = createCatalogWriteService({ db, outbox });
    await catalog.repairProperty(id);
    const removed = await catalog.deleteProperty(id);
    expect(removed.data.snapshot.deleted).toBe(true);
    expect(removed.aggregate_version).toBe(2);
    expect(await catalog.deleteProperty(id)).toBeNull();
    expect(await events(id)).toHaveLength(2);
    await expect(
      catalog.updateProperty(id, { name: "resurrection" }),
    ).rejects.toMatchObject({ code: "PROPERTY_DELETED" });
    await db("catalog_versions").where({ property_id: id }).del();
  });
});
