function createPaymentRepository(db) {
  return {
    async findOwnedBookingForUpdate(userId, bookingId, trx = db) {
      return trx("bookings")
        .where({ id: bookingId, user_id: userId })
        .forUpdate()
        .first();
    },

    findReusableAttempt(bookingId, now, trx = db) {
      return trx("payments")
        .where({ booking_id: bookingId })
        .whereIn("status", ["CREATED", "PENDING"])
        .where("expires_at", ">", now)
        .orderBy("attempt_number", "desc")
        .first();
    },

    async nextAttemptNumber(bookingId, trx = db) {
      const row = await trx("payments")
        .where({ booking_id: bookingId })
        .max("attempt_number as max")
        .first();
      return Number(row.max || 0) + 1;
    },

    async create(input, trx = db) {
      const [row] = await trx("payments").insert(input).returning("*");
      return row;
    },

    async updateIfNotSucceeded(paymentId, patch, trx = db) {
      const [row] = await trx("payments")
        .where({ id: paymentId })
        .whereNot({ status: "SUCCEEDED" })
        .update({ ...patch, updated_at: trx.fn.now() })
        .returning("*");
      return row || trx("payments").where({ id: paymentId }).first();
    },

    findOwnedById(userId, paymentId, trx = db, lock = false) {
      let query = trx("payments as pay")
        .join("bookings as b", "b.id", "pay.booking_id")
        .where({ "pay.id": paymentId, "b.user_id": userId })
        .select("pay.*", "b.status as booking_status", "b.user_id")
        .first();
      if (lock) query = query.forUpdate("pay");
      return query;
    },

    findByAppTransId(appTransId, trx = db, lock = false) {
      let query = trx("payments").where({ app_trans_id: appTransId }).first();
      if (lock) query = query.forUpdate();
      return query;
    },

    findById(paymentId, trx = db, lock = false) {
      let query = trx("payments").where({ id: paymentId }).first();
      if (lock) query = query.forUpdate();
      return query;
    },

    findBookingById(bookingId, trx = db, lock = false) {
      let query = trx("bookings").where({ id: bookingId }).first();
      if (lock) query = query.forUpdate();
      return query;
    },

    lockBookingAllocation(bookingId, trx = db) {
      return trx("booking_nights as bn")
        .join("rooms as r", "r.id", "bn.room_id")
        .join("room_availability as ra", function joinAvailability() {
          this.on("ra.room_id", "=", "bn.room_id").andOn(
            "ra.stay_date",
            "=",
            "bn.stay_date",
          );
        })
        .where("bn.booking_id", bookingId)
        .select(
          "bn.room_id",
          "bn.stay_date",
          "ra.status",
          "ra.booking_id",
          "r.room_code",
        )
        .orderBy([{ column: "bn.room_id" }, { column: "bn.stay_date" }])
        .forUpdate("ra");
    },

    async markSucceeded(paymentId, providerTransId, paidAt, trx = db) {
      const [row] = await trx("payments")
        .where({ id: paymentId })
        .update({
          status: "SUCCEEDED",
          provider_trans_id: providerTransId,
          paid_at: paidAt,
          updated_at: trx.fn.now(),
        })
        .returning("*");
      return row;
    },

    markFailed(paymentId, code, message, trx = db) {
      return trx("payments")
        .where({ id: paymentId })
        .whereNot({ status: "SUCCEEDED" })
        .update({
          status: "FAILED",
          provider_code: code || null,
          provider_message: message?.slice(0, 500) || null,
          updated_at: trx.fn.now(),
        });
    },

    confirmBooking(bookingId, now, trx = db) {
      return trx("bookings")
        .where({ id: bookingId })
        .whereIn("status", ["PENDING_PAYMENT", "EXPIRED"])
        .update({ status: "CONFIRMED", confirmed_at: now, updated_at: now });
    },

    bookHeldAvailability(bookingId, now, trx = db) {
      return trx("room_availability")
        .where({ booking_id: bookingId, status: "HELD" })
        .update({ status: "BOOKED", updated_at: now });
    },

    async reclaimAllocation(bookingId, allocation, now, trx = db) {
      let updated = 0;
      for (const row of allocation) {
        updated += await trx("room_availability")
          .where({ room_id: row.room_id, stay_date: row.stay_date })
          .where((builder) =>
            builder
              .where({ status: "OPEN", booking_id: null })
              .orWhere({ booking_id: bookingId }),
          )
          .update({ status: "BOOKED", booking_id: bookingId, updated_at: now });
      }
      return updated;
    },

    async duePendingBookings(now, limit = 50, trx = db) {
      return trx("bookings")
        .where({ status: "PENDING_PAYMENT" })
        .where("hold_expires_at", "<=", now)
        .orderBy("hold_expires_at")
        .limit(limit)
        .select("id", "hold_expires_at");
    },

    latestAttempt(bookingId, trx = db) {
      return trx("payments")
        .where({ booking_id: bookingId })
        .orderBy("attempt_number", "desc")
        .first();
    },

    async integrityMismatches(trx = db) {
      return trx("room_availability as ra")
        .join("bookings as b", "b.id", "ra.booking_id")
        .where((builder) =>
          builder
            .where((held) =>
              held
                .where("ra.status", "HELD")
                .whereNot("b.status", "PENDING_PAYMENT"),
            )
            .orWhere((booked) =>
              booked
                .where("ra.status", "BOOKED")
                .whereNot("b.status", "CONFIRMED"),
            ),
        )
        .select(
          "ra.room_id",
          "ra.stay_date",
          "ra.status",
          "b.id as booking_id",
          "b.status as booking_status",
        );
    },
  };
}

module.exports = { createPaymentRepository };
