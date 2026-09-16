const request = require("supertest");
const { createApp } = require("../../src/app");
const { createApiRouter } = require("../../src/routes");
const { db, checkDatabase, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const { addDays, todayInTimezone } = require("../../src/shared/dates");
const {
  hmacSha256,
} = require("../../src/modules/payments/providers/zalopay.provider");

const STANDARD_DOUBLE = "30000000-0000-4000-8000-000000000001";
const FAMILY_SUITE = "30000000-0000-4000-8000-000000000002";
const PINE_HOUSE = "30000000-0000-4000-8000-000000000007";
const GARDEN_DOUBLE = "30000000-0000-4000-8000-000000000008";
const PINE_PROPERTY = "10000000-0000-4000-8000-000000000004";

describe("Phase 1 API integration flow", () => {
  const env = getEnv();
  const apiRouter = createApiRouter();
  const app = createApp({ checkDatabase, apiRouter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const emails = [`api-a-${suffix}@example.com`, `api-b-${suffix}@example.com`];
  let tokenA;
  let tokenB;
  let userA;
  let userB;

  const today = todayInTimezone(env.businessTimezone);
  const checkIn = addDays(today, 30);
  const checkOut = addDays(today, 32);
  const contact = {
    fullName: "Integration Guest",
    email: emails[0],
    phone: "0901234567",
  };

  async function cleanup() {
    const users = await db("users").whereIn("email", emails).select("id");
    const userIds = users.map((user) => user.id);
    if (!userIds.length) return;
    const bookings = await db("bookings")
      .whereIn("user_id", userIds)
      .select("id");
    const bookingIds = bookings.map((booking) => booking.id);
    if (bookingIds.length) {
      await db("room_availability")
        .whereIn("booking_id", bookingIds)
        .update({ status: "OPEN", booking_id: null, updated_at: db.fn.now() });
      await db("payments").whereIn("booking_id", bookingIds).del();
      await db("booking_nights").whereIn("booking_id", bookingIds).del();
      await db("booking_rooms").whereIn("booking_id", bookingIds).del();
      await db("bookings").whereIn("id", bookingIds).del();
    }
    const carts = await db("carts").whereIn("user_id", userIds).select("id");
    const cartIds = carts.map((cart) => cart.id);
    if (cartIds.length)
      await db("cart_items").whereIn("cart_id", cartIds).del();
    await db("carts").whereIn("user_id", userIds).del();
    await db("users").whereIn("id", userIds).del();
  }

  beforeAll(async () => {
    await cleanup();
    const responses = await Promise.all(
      emails.map((email, index) =>
        request(app)
          .post("/api/v1/auth/register")
          .send({
            email,
            password: "StrongPass1!",
            fullName: `Integration User ${index + 1}`,
            phone: `090123456${index}`,
          }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    tokenA = responses[0].body.data.accessToken;
    tokenB = responses[1].body.data.accessToken;
    userA = responses[0].body.data.user;
    userB = responses[1].body.data.user;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  it("browses catalog and returns a whole-stay availability quote", async () => {
    const catalog = await request(app)
      .get("/api/v1/properties")
      .query({ city: "Lâm Đồng" });
    expect(catalog.status).toBe(200);
    expect(catalog.body.data[0].id).toBe(PINE_PROPERTY);

    const availability = await request(app)
      .get(
        `/api/v1/properties/${PINE_PROPERTY}/room-types/${PINE_HOUSE}/availability`,
      )
      .query({ checkIn, checkOut, roomQuantity: 1, adults: 2, children: 0 });
    expect(availability.status).toBe(200);
    expect(availability.body.data.available).toBe(true);
    expect(availability.body.data.bookableRooms).toBe(1);
    expect(availability.body.data.nightly).toHaveLength(2);
  });

  it("rejects fragmented inventory and a stay outside the generated calendar", async () => {
    const fragmentedCheckIn = addDays(today, 50);
    const fragmentedCheckOut = addDays(today, 53);
    const rooms = await db("rooms")
      .where({ room_type_id: GARDEN_DOUBLE })
      .orderBy("room_code");
    const dates = [
      fragmentedCheckIn,
      addDays(fragmentedCheckIn, 1),
      addDays(fragmentedCheckIn, 2),
    ];
    try {
      await db("room_availability")
        .whereIn(
          "room_id",
          rooms.map((room) => room.id),
        )
        .whereIn("stay_date", dates)
        .update({ status: "OPEN", booking_id: null, updated_at: db.fn.now() });
      for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
        await db("room_availability")
          .where({ room_id: rooms[roomIndex].id })
          .whereIn(
            "stay_date",
            dates.filter((_date, dateIndex) => dateIndex !== roomIndex),
          )
          .update({
            status: "CLOSED",
            booking_id: null,
            updated_at: db.fn.now(),
          });
      }
      const response = await request(app)
        .get(
          `/api/v1/properties/${PINE_PROPERTY}/room-types/${GARDEN_DOUBLE}/availability`,
        )
        .query({
          checkIn: fragmentedCheckIn,
          checkOut: fragmentedCheckOut,
          roomQuantity: 1,
          adults: 2,
          children: 0,
        });
      expect(response.status).toBe(200);
      expect(
        response.body.data.nightly.map((night) => night.openRooms),
      ).toEqual([1, 1, 1]);
      expect(response.body.data.bookableRooms).toBe(0);
      expect(response.body.data.available).toBe(false);
    } finally {
      await db("room_availability")
        .whereIn(
          "room_id",
          rooms.map((room) => room.id),
        )
        .whereIn("stay_date", dates)
        .where({ status: "CLOSED" })
        .update({ status: "OPEN", booking_id: null, updated_at: db.fn.now() });
    }

    const outside = await request(app)
      .get(
        `/api/v1/properties/${PINE_PROPERTY}/room-types/${PINE_HOUSE}/availability`,
      )
      .query({
        checkIn: addDays(today, env.availabilityWindowDays - 1),
        checkOut: addDays(today, env.availabilityWindowDays + 1),
        roomQuantity: 1,
        adults: 1,
        children: 0,
      });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe("STAY_OUTSIDE_CALENDAR");
  });

  it("checks out one cart item atomically, preserves the other and retries idempotently", async () => {
    const selections = [
      {
        roomTypeId: STANDARD_DOUBLE,
        checkIn,
        checkOut,
        roomQuantity: 1,
        adults: 2,
        children: 0,
      },
      {
        roomTypeId: FAMILY_SUITE,
        checkIn,
        checkOut,
        roomQuantity: 1,
        adults: 3,
        children: 0,
      },
    ];
    const added = [];
    for (const selection of selections) {
      added.push(
        await request(app)
          .post("/api/v1/cart/items")
          .set("Authorization", `Bearer ${tokenA}`)
          .send(selection),
      );
    }
    expect(added.map((response) => response.status)).toEqual([201, 201]);
    const body = {
      cartItemId: added[0].body.data.id,
      contact,
      specialRequests: "Late arrival",
    };
    const key = `cart-${suffix}`;
    const created = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.rooms).toHaveLength(1);
    expect(created.body.data.nights).toHaveLength(2);

    const retry = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(created.body.data.id);

    const cart = await request(app)
      .get("/api/v1/cart")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(cart.body.data.items).toHaveLength(1);
    expect(cart.body.data.items[0].selection.roomTypeId).toBe(FAMILY_SUITE);

    const mismatch = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send({ ...body, specialRequests: "Different payload" });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("allows only one concurrent booking for the last physical room", async () => {
    const makeRequest = (token, email, key) =>
      request(app)
        .post("/api/v1/bookings")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({
          roomTypeId: PINE_HOUSE,
          checkIn,
          checkOut,
          roomQuantity: 1,
          adults: 2,
          children: 0,
          contact: { ...contact, email },
        });
    const responses = await Promise.all([
      makeRequest(tokenA, emails[0], `race-a-${suffix}`),
      makeRequest(tokenB, emails[1], `race-b-${suffix}`),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      responses.find((response) => response.status === 409).body.error.code,
    ).toBe("ROOM_UNAVAILABLE");

    const winner = responses.find((response) => response.status === 201);
    const winnerToken = winner.body.data.id
      ? (await db("bookings").where({ id: winner.body.data.id }).first())
          .user_id === userA.id
        ? tokenA
        : tokenB
      : tokenA;
    const cancellation = await request(app)
      .post(`/api/v1/bookings/${winner.body.data.id}/cancellations`)
      .set("Authorization", `Bearer ${winnerToken}`)
      .send({ reason: "Integration cleanup" });
    expect(cancellation.status).toBe(200);
    expect(cancellation.body.data.status).toBe("CANCELLED");
    const occupied = await db("room_availability")
      .where({ booking_id: winner.body.data.id })
      .count("* as count")
      .first();
    expect(Number(occupied.count)).toBe(0);
  });

  it("self-heals an expired hold when the next booking locks the same inventory", async () => {
    const selfHealCheckIn = addDays(today, 40);
    const selfHealCheckOut = addDays(today, 42);
    const payload = (email) => ({
      roomTypeId: PINE_HOUSE,
      checkIn: selfHealCheckIn,
      checkOut: selfHealCheckOut,
      roomQuantity: 1,
      adults: 2,
      children: 0,
      contact: { ...contact, email },
    });
    const stale = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", `stale-${suffix}`)
      .send(payload(emails[0]));
    expect(stale.status).toBe(201);
    await db("bookings")
      .where({ id: stale.body.data.id })
      .update({ hold_expires_at: new Date(Date.now() - 1000) });

    const replacement = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", `replacement-${suffix}`)
      .send(payload(emails[1]));
    expect(replacement.status).toBe(201);
    expect(
      (await db("bookings").where({ id: stale.body.data.id }).first()).status,
    ).toBe("EXPIRED");
    const staleRows = await db("room_availability")
      .where({ booking_id: stale.body.data.id })
      .count("* as count")
      .first();
    expect(Number(staleRows.count)).toBe(0);

    const cancellation = await request(app)
      .post(`/api/v1/bookings/${replacement.body.data.id}/cancellations`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ reason: "Integration cleanup" });
    expect(cancellation.status).toBe(200);
  });

  it("commits local expiry before rejecting a payment created after the hold deadline", async () => {
    const expiryCheckIn = addDays(today, 60);
    const expiryCheckOut = addDays(today, 61);
    const booking = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", `expired-payment-${suffix}`)
      .send({
        roomTypeId: STANDARD_DOUBLE,
        checkIn: expiryCheckIn,
        checkOut: expiryCheckOut,
        roomQuantity: 1,
        adults: 1,
        children: 0,
        contact,
      });
    expect(booking.status).toBe(201);
    await db("bookings")
      .where({ id: booking.body.data.id })
      .update({ hold_expires_at: new Date(Date.now() - 1000) });
    const payment = await request(app)
      .post(`/api/v1/bookings/${booking.body.data.id}/payments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ provider: "ZALOPAY" });
    expect(payment.status).toBe(409);
    expect(payment.body.error.code).toBe("BOOKING_HOLD_EXPIRED");
    expect(
      (await db("bookings").where({ id: booking.body.data.id }).first()).status,
    ).toBe("EXPIRED");
    const occupied = await db("room_availability")
      .where({ booking_id: booking.body.data.id })
      .count("* as count")
      .first();
    expect(Number(occupied.count)).toBe(0);
  });

  it("expires an unpaid booking through the reconciliation service and leaves no state mismatch", async () => {
    const expiryCheckIn = addDays(today, 70);
    const expiryCheckOut = addDays(today, 72);
    const booking = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", `scheduler-expiry-${suffix}`)
      .send({
        roomTypeId: PINE_HOUSE,
        checkIn: expiryCheckIn,
        checkOut: expiryCheckOut,
        roomQuantity: 1,
        adults: 2,
        children: 0,
        contact,
      });
    expect(booking.status).toBe(201);
    await db("bookings")
      .where({ id: booking.body.data.id })
      .update({ hold_expires_at: new Date(Date.now() - 1000) });

    const result =
      await apiRouter.runtimeServices.paymentService.reconcileExpiredBatch();

    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.mismatches).toEqual([]);
    expect(
      (await db("bookings").where({ id: booking.body.data.id }).first()).status,
    ).toBe("EXPIRED");
    const occupied = await db("room_availability")
      .where({ booking_id: booking.body.data.id })
      .count("* as count")
      .first();
    expect(Number(occupied.count)).toBe(0);
  });

  it("creates a mock payment and confirms it only through a valid callback", async () => {
    const booking = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", `payment-${suffix}`)
      .send({
        roomTypeId: PINE_HOUSE,
        checkIn,
        checkOut,
        roomQuantity: 1,
        adults: 2,
        children: 0,
        contact: { ...contact, email: emails[1] },
      });
    expect(booking.status).toBe(201);
    const payment = await request(app)
      .post(`/api/v1/bookings/${booking.body.data.id}/payments`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ provider: "ZALOPAY" });
    expect(payment.status).toBe(201);
    expect(payment.body.data.checkoutUrl).toMatch(
      /^https:\/\/mock-payments\.local/,
    );
    const paymentRow = await db("payments")
      .where({ id: payment.body.data.id })
      .first();
    const callbackData = JSON.stringify({
      app_id: "MOCK",
      app_trans_id: paymentRow.app_trans_id,
      amount: Number(paymentRow.amount),
      zp_trans_id: `zp-${Date.now()}`,
      server_time: Date.now(),
    });
    const key2 = env.zalopay.key2 || "mock-callback-key";
    const callback = await request(app)
      .post("/api/v1/payments/zalopay/callback")
      .send({
        data: callbackData,
        mac: hmacSha256(key2, callbackData),
        type: 1,
      });
    expect(callback.status).toBe(200);
    expect(callback.body.return_code).toBe(1);

    const details = await request(app)
      .get(`/api/v1/bookings/${booking.body.data.id}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(details.body.data.status).toBe("CONFIRMED");
    expect(details.body.data.payments[0].status).toBe("SUCCEEDED");
    const bookedRows = await db("room_availability")
      .where({ booking_id: booking.body.data.id, status: "BOOKED" })
      .count("* as count")
      .first();
    expect(Number(bookedRows.count)).toBe(2);

    const hidden = await request(app)
      .get(`/api/v1/bookings/${booking.body.data.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(hidden.status).toBe(404);
    expect(userB.id).not.toBe(userA.id);
  });
});
