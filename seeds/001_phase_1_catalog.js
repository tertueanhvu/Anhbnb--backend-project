const catalog = require("./phase-1-catalog.json");
const { addDays, todayInTimezone } = require("../src/shared/dates");

exports.seed = async function seed(knex) {
  if (await knex.schema.hasTable("catalog_versions")) {
    const version = await knex("catalog_versions").first("property_id");
    if (version)
      throw new Error(
        "Catalog events already initialized: use catalog:update / catalog:repair; seed must not silently bypass outbox.",
      );
  }
  const now = new Date();

  await knex.transaction(async (trx) => {
    await trx("amenities").insert(catalog.amenities).onConflict("id").merge();
    await trx("properties").insert(catalog.properties).onConflict("id").merge();
    await trx("property_images")
      .insert(catalog.property_images)
      .onConflict("id")
      .merge();
    await trx("property_amenities")
      .insert(catalog.property_amenities)
      .onConflict(["property_id", "amenity_id"])
      .ignore();
    await trx("room_types").insert(catalog.room_types).onConflict("id").merge();
    await trx("rooms").insert(catalog.rooms).onConflict("id").merge();

    const timezone = process.env.BUSINESS_TIMEZONE || "Asia/Ho_Chi_Minh";
    const windowDays = Number(
      process.env.AVAILABILITY_WINDOW_DAYS || catalog.availability_window_days,
    );
    const today = todayInTimezone(timezone, now);
    const priceByRoomType = new Map(
      catalog.room_types.map((roomType) => [roomType.id, roomType.base_price]),
    );
    const rows = [];
    for (const room of catalog.rooms) {
      for (let day = 0; day < windowDays; day += 1) {
        rows.push({
          room_id: room.id,
          stay_date: addDays(today, day),
          price: priceByRoomType.get(room.room_type_id),
          status: "OPEN",
          booking_id: null,
          updated_at: now,
        });
      }
    }

    for (let index = 0; index < rows.length; index += 1000) {
      await trx("room_availability")
        .insert(rows.slice(index, index + 1000))
        .onConflict(["room_id", "stay_date"])
        .ignore();
    }
  });
};
