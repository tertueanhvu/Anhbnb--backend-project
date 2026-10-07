function createBulkQuoteRepository(db) {
  return {
    async read(propertyIds, selection) {
      if (!propertyIds.length) return { roomTypes: [], rows: [] };
      if (propertyIds.length > 100)
        throw new Error("BULK_QUOTE_BATCH_TOO_LARGE");
      // One consistent snapshot for metadata + room/date rows. No locks on GET.
      return db.transaction(
        async (trx) => {
          await trx.raw("SET LOCAL statement_timeout = '1500ms'");
          const roomTypes = await trx("room_types as rt")
            .join("properties as p", "p.id", "rt.property_id")
            .join("rooms as r", "r.room_type_id", "rt.id")
            .whereIn("p.id", propertyIds)
            .where("p.status", "ACTIVE")
            .groupBy("rt.id")
            .select("rt.*", trx.raw("count(r.id)::integer as room_count"));
          const rows = await trx("room_availability as ra")
            .join("rooms as r", "r.id", "ra.room_id")
            .whereIn(
              "r.room_type_id",
              roomTypes.map((row) => row.id),
            )
            .where("ra.stay_date", ">=", selection.checkIn)
            .where("ra.stay_date", "<", selection.checkOut)
            .orderBy(["r.room_type_id", "r.id", "ra.stay_date"])
            .select(
              "r.room_type_id",
              "r.id as room_id",
              "r.room_code",
              "ra.stay_date",
              "ra.price",
              "ra.status",
              "ra.booking_id",
            );
          return { roomTypes, rows };
        },
        { isolationLevel: "repeatable read", readOnly: true },
      );
    },
  };
}
module.exports = { createBulkQuoteRepository };
