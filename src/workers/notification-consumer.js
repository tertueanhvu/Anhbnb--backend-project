const Joi = require("joi");
const templates = {
  BookingHeld: "hold-created",
  BookingConfirmed: "booking-confirmed",
  BookingCancelled: "booking-cancelled",
  BookingExpired: "booking-expired",
};
const identity = Joi.object({
  booking_id: Joi.string().uuid().required(),
  user_id: Joi.string().uuid().required(),
}).unknown(true);

function createNotificationConsumer({ inbox }) {
  const name = "notification-v1";
  return {
    name,
    topics: ["booking", "payment"],
    async handle(event) {
      const template = templates[event.event_type];
      if (
        template &&
        (event.aggregate_type !== "booking" ||
          event.aggregate_id !== event.data.booking_id ||
          identity.validate(event.data).error)
      )
        throw new Error("INVALID_NOTIFICATION_EVENT");
      return inbox.transaction(name, event.event_id, async (trx) => {
        // PaymentSucceeded deliberately does NOT send another booking confirmation.
        if (!template) return;
        const booking = await trx("bookings")
          .where({ id: event.data.booking_id })
          .first("id", "user_id");
        if (!booking || booking.user_id !== event.data.user_id)
          throw new Error("NOTIFICATION_BOOKING_MISMATCH");
        await trx("notification_jobs")
          .insert({
            event_id: event.event_id,
            template,
            recipient_ref: booking.user_id,
            booking_id: booking.id,
          })
          .onConflict(["event_id", "channel", "template", "recipient_ref"])
          .ignore();
      });
    },
  };
}
module.exports = { createNotificationConsumer };
