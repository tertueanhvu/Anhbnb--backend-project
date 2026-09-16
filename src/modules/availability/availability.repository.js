function createAvailabilityRepository(db) {
  return {
    async getRoomType(roomTypeId, trx = db) {
      const row = await trx("room_types as rt")
        .join("properties as p", "p.id", "rt.property_id")
        .leftJoin("rooms as r", "r.room_type_id", "rt.id")
        .where("rt.id", roomTypeId)
        .groupBy("rt.id", "p.id")
        .select(
          "rt.*",
          "p.status as property_status",
          "p.name as property_name",
          trx.raw("count(r.id)::integer as room_count"),
        )
        .first();
      return row;
    },

    async getMatrix({ roomTypeId, checkIn, checkOut, lock = false }, trx = db) {
      let query = trx("room_availability as ra")
        .join("rooms as r", "r.id", "ra.room_id")
        .leftJoin("bookings as b", "b.id", "ra.booking_id")
        .where("r.room_type_id", roomTypeId)
        .where("ra.stay_date", ">=", checkIn)
        .where("ra.stay_date", "<", checkOut)
        .orderBy([
          { column: "r.id", order: "asc" },
          { column: "ra.stay_date", order: "asc" },
        ])
        .select(
          "r.id as room_id",
          "r.room_code",
          "ra.stay_date",
          "ra.price",
          "ra.status",
          "ra.booking_id",
          "b.status as booking_status",
          "b.hold_expires_at",
        );
      if (lock) query = query.forUpdate("ra");
      return query;
    },

    async insertWindowRows(rows, trx = db) {
      if (!rows.length) return 0;
      const result = await trx("room_availability")
        .insert(rows)
        .onConflict(["room_id", "stay_date"])
        .ignore()
        .returning(["room_id", "stay_date"]);
      return result.length;
    },

    listRoomsWithBasePrice(trx = db) {
      return trx("rooms as r")
        .join("room_types as rt", "rt.id", "r.room_type_id")
        .select("r.id as room_id", "rt.base_price");
    },
  };
}

module.exports = { createAvailabilityRepository };
