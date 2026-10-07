const { createEnvelope } = require("./event-envelope");
const { eventContext } = require("./event-context");
const bookingTypes = {
  PENDING_PAYMENT: "BookingHeld",
  CONFIRMED: "BookingConfirmed",
  CANCELLED: "BookingCancelled",
  EXPIRED: "BookingExpired",
  COMPLETED: "BookingCompleted",
};
const paymentTypes = {
  CREATED: "PaymentCreated",
  PENDING: "PaymentPending",
  SUCCEEDED: "PaymentSucceeded",
  FAILED: "PaymentFailed",
  EXPIRED: "PaymentExpired",
};

function createOutboxRepository() {
  async function append(trx, input) {
    if (!trx?.isTransaction)
      throw new Error("OUTBOX_REQUIRES_BUSINESS_TRANSACTION");
    const event = createEnvelope({
      ...input,
      requestId: input.requestId ?? eventContext.getStore()?.requestId ?? null,
    });
    await trx("outbox_events").insert({
      event_id: event.event_id,
      aggregate_type: event.aggregate_type,
      aggregate_id: event.aggregate_id,
      aggregate_version: event.aggregate_version,
      event_type: event.event_type,
      request_id: event.request_id,
      occurred_at: event.occurred_at,
      payload: event,
    });
    return event;
  }
  return {
    append,
    async transition(trx, kind, row) {
      if (!trx?.isTransaction)
        throw new Error("OUTBOX_REQUIRES_BUSINESS_TRANSACTION");
      const table =
        kind === "booking"
          ? "bookings"
          : kind === "payment"
            ? "payments"
            : null;
      if (!table) throw new Error("INVALID_AGGREGATE_TYPE");
      const [version] = await trx(table)
        .where({ id: row.id })
        .update({ event_version: trx.raw("event_version + 1") })
        .returning("event_version");
      const booking =
        kind === "booking"
          ? row
          : await trx("bookings").where({ id: row.booking_id }).first();
      const data = {
        booking_id: booking.id,
        user_id: booking.user_id,
        status: row.status,
        ...(kind === "booking"
          ? {
              room_type_id: row.room_type_id,
              room_quantity: row.room_quantity,
              check_in: row.check_in,
              check_out: row.check_out,
              total_amount: Number(row.total_amount),
              currency: row.currency,
              hold_expires_at: row.hold_expires_at,
            }
          : {
              payment_id: row.id,
              amount: Number(row.amount),
              currency: row.currency,
              booking_status: booking.status,
              manual_refund_required:
                row.status === "SUCCEEDED" && booking.status !== "CONFIRMED",
            }),
      };
      return append(trx, {
        aggregateType: kind,
        aggregateId: row.id,
        version: version.event_version,
        eventType: (kind === "booking" ? bookingTypes : paymentTypes)[
          row.status
        ],
        data,
      });
    },
  };
}
module.exports = { createOutboxRepository };
