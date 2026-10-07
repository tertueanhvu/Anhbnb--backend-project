const { randomUUID } = require("node:crypto");
const { addDays, todayInTimezone } = require("../../src/shared/dates");
const { assertTestDatabase } = require("./redis");

async function bookingFixture(db, env) {
  assertTestDatabase(env.databaseUrl);
  const propertyId = randomUUID(),
    roomTypeId = randomUUID(),
    roomId = randomUUID();
  const users = [randomUUID(), randomUUID()];
  const emails = users.map((id) => `${id}@example.com`);
  const checkIn = addDays(todayInTimezone(env.businessTimezone), 80);
  const checkOut = addDays(checkIn, 2);
  await db.transaction(async (trx) => {
    await trx("users").insert(
      users.map((id, index) => ({
        id,
        email: emails[index],
        password_hash: "test-only-unused-hash",
        full_name: "Redis test guest",
      })),
    );
    await trx("properties").insert({
      id: propertyId,
      slug: `redis-test-${propertyId}`,
      name: "Redis Test Hotel",
      address_line: "Test address",
      city: "Redis Test City",
    });
    await trx("room_types").insert({
      id: roomTypeId,
      property_id: propertyId,
      name: "Only room",
      max_guests: 2,
      base_price: 500000,
    });
    await trx("rooms").insert({
      id: roomId,
      room_type_id: roomTypeId,
      property_id: propertyId,
      room_code: "R1",
    });
    await trx("room_availability").insert(
      [checkIn, addDays(checkIn, 1)].map((stay_date) => ({
        room_id: roomId,
        stay_date,
        price: 500000,
      })),
    );
  });
  return {
    propertyId,
    roomTypeId,
    roomId,
    users,
    emails,
    checkIn,
    checkOut,
    body: {
      roomTypeId,
      checkIn,
      checkOut,
      roomQuantity: 1,
      adults: 2,
      children: 0,
      contact: {
        fullName: "Redis Test Guest",
        email: emails[0],
        phone: "0901234567",
      },
    },
    async cleanup() {
      await db.transaction(async (trx) => {
        const ids = (
          await trx("bookings").whereIn("user_id", users).select("id")
        ).map((row) => row.id);
        await trx("room_availability").where({ room_id: roomId }).del();
        if (ids.length) {
          await trx("payments").whereIn("booking_id", ids).del();
          await trx("bookings").whereIn("id", ids).del();
        }
        await trx("users").whereIn("id", users).del();
        await trx("rooms").where({ id: roomId }).del();
        await trx("room_types").where({ id: roomTypeId }).del();
        await trx("properties").where({ id: propertyId }).del();
      });
    },
  };
}
module.exports = { bookingFixture };
