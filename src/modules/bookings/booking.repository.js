function createBookingRepository(db, { outbox } = {}) {
  const transaction = (trx, work) =>
    outbox && !trx.isTransaction ? trx.transaction(work) : work(trx);
  return {
    findByIdempotency(userId, key, trx = db, lock = false) {
      let query = trx("bookings")
        .where({ user_id: userId, idempotency_key: key })
        .first();
      if (lock) query = query.forUpdate();
      return query;
    },

    findOwnedCartItem(userId, itemId, trx = db) {
      return trx("cart_items as ci")
        .join("carts as c", "c.id", "ci.cart_id")
        .where({ "ci.id": itemId, "c.user_id": userId })
        .select("ci.*")
        .first();
    },

    async expireHeldBookings(bookingIds, now, trx = db) {
      if (!bookingIds.length) return [];
      return transaction(trx, async (trx) => {
        const expired = await trx("bookings")
          .whereIn("id", bookingIds)
          .where("status", "PENDING_PAYMENT")
          .where("hold_expires_at", "<=", now)
          .update({ status: "EXPIRED", updated_at: now })
          .returning("*");
        const ids = expired.map((row) => row.id);
        if (ids.length) {
          await trx("room_availability")
            .whereIn("booking_id", ids)
            .where("status", "HELD")
            .update({ status: "OPEN", booking_id: null, updated_at: now });
          const payments = await trx("payments")
            .whereIn("booking_id", ids)
            .whereIn("status", ["CREATED", "PENDING"])
            .update({ status: "EXPIRED", updated_at: now })
            .returning("*");
          for (const row of expired)
            await outbox?.transition(trx, "booking", row);
          for (const row of payments)
            await outbox?.transition(trx, "payment", row);
        }
        return ids;
      });
    },

    async insertBooking(input, trx = db) {
      return transaction(trx, async (trx) => {
        const [row] = await trx("bookings").insert(input).returning("*");
        await outbox?.transition(trx, "booking", row);
        return row;
      });
    },

    insertBookingRooms(rows, trx = db) {
      return trx("booking_rooms").insert(rows);
    },

    insertBookingNights(rows, trx = db) {
      return trx("booking_nights").insert(rows);
    },

    holdAvailability(bookingId, selectedRooms, now, trx = db) {
      const roomIds = selectedRooms.map((room) => room.roomId);
      const dates = selectedRooms.flatMap((room) =>
        room.nights.map((night) => night.date),
      );
      return trx("room_availability")
        .whereIn("room_id", roomIds)
        .whereIn("stay_date", [...new Set(dates)])
        .where({ status: "OPEN" })
        .update({ status: "HELD", booking_id: bookingId, updated_at: now });
    },

    deleteCartItem(itemId, trx = db) {
      return trx("cart_items").where({ id: itemId }).del();
    },

    async findOwnedById(userId, bookingId, trx = db, lock = false) {
      let query = trx("bookings as b")
        .join("room_types as rt", "rt.id", "b.room_type_id")
        .join("properties as p", "p.id", "rt.property_id")
        .where({ "b.id": bookingId, "b.user_id": userId })
        .select(
          "b.*",
          "rt.name as room_type_name",
          "rt.property_id",
          "p.name as property_name",
        )
        .first();
      if (lock) query = query.forUpdate("b");
      return query;
    },

    getAssignedRooms(bookingId, trx = db) {
      return trx("booking_rooms as br")
        .join("rooms as r", "r.id", "br.room_id")
        .where("br.booking_id", bookingId)
        .select("r.id as room_id", "r.room_code")
        .orderBy("r.room_code");
    },

    getNights(bookingId, trx = db) {
      return trx("booking_nights as bn")
        .join("rooms as r", "r.id", "bn.room_id")
        .where("bn.booking_id", bookingId)
        .select("bn.room_id", "r.room_code", "bn.stay_date", "bn.price")
        .orderBy([{ column: "r.room_code" }, { column: "bn.stay_date" }]);
    },

    getPayments(bookingId, trx = db) {
      return trx("payments")
        .where({ booking_id: bookingId })
        .select(
          "id",
          "provider",
          "status",
          "amount",
          "currency",
          "expires_at",
          "paid_at",
        )
        .orderBy("attempt_number", "desc");
    },

    async listOwned(userId, filters, pagination, trx = db) {
      const base = trx("bookings as b").where("b.user_id", userId);
      if (filters.status) base.where("b.status", filters.status);
      if (filters.from) base.where("b.check_out", ">", filters.from);
      if (filters.to) base.where("b.check_in", "<", filters.to);
      const [{ count }] = await base
        .clone()
        .clearSelect()
        .clearOrder()
        .count("* as count");
      const rows = await base
        .join("room_types as rt", "rt.id", "b.room_type_id")
        .join("properties as p", "p.id", "rt.property_id")
        .select(
          "b.*",
          "rt.name as room_type_name",
          "p.id as property_id",
          "p.name as property_name",
        )
        .orderBy([
          { column: "b.created_at", order: "desc" },
          { column: "b.id", order: "desc" },
        ])
        .limit(pagination.limit)
        .offset(pagination.offset);
      return { rows, total: Number(count) };
    },

    async updateStatus(bookingId, patch, trx = db) {
      return transaction(trx, async (trx) => {
        const before = await trx("bookings")
          .where({ id: bookingId })
          .forUpdate()
          .first();
        const [row] = await trx("bookings")
          .where({ id: bookingId })
          .update({ ...patch, updated_at: trx.fn.now() })
          .returning("*");
        if (row && row.status !== before.status)
          await outbox?.transition(trx, "booking", row);
        return row;
      });
    },

    releaseAvailability(bookingId, trx = db) {
      return trx("room_availability")
        .where({ booking_id: bookingId })
        .whereIn("status", ["HELD", "BOOKED"])
        .update({ status: "OPEN", booking_id: null, updated_at: trx.fn.now() });
    },

    lockAvailabilityForBooking(bookingId, trx = db) {
      return trx("room_availability")
        .where({ booking_id: bookingId })
        .orderBy([{ column: "room_id" }, { column: "stay_date" }])
        .forUpdate();
    },
  };
}

module.exports = { createBookingRepository };
