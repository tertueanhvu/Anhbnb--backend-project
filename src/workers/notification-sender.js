const { randomUUID } = require("node:crypto");

function createLogTransport(logger) {
  return {
    async send({ job }) {
      // No address/body/PII in logs. This is a development sink, not real email.
      logger.info(
        {
          notificationId: job.id,
          eventId: job.event_id,
          template: job.template,
        },
        "Notification logged (no email sent)",
      );
    },
  };
}

function createNotificationSender({
  db,
  transport,
  metrics,
  leaseMs = 30000,
  maxAttempts = 5,
}) {
  async function tick() {
    // A crashed sender may have sent externally. Never blindly resend UNKNOWN.
    await db("notification_jobs")
      .where({ status: "SENDING" })
      .where("locked_until", "<", db.fn.now())
      .update({
        status: "UNKNOWN",
        last_error_code: "SEND_OUTCOME_UNKNOWN",
        lock_token: null,
        locked_until: null,
      });
    const job = await db.transaction(async (trx) => {
      const due = await trx("notification_jobs")
        .whereIn("status", ["PENDING", "FAILED"])
        .where("available_at", "<=", trx.fn.now())
        .where("attempts", "<", maxAttempts)
        .orderBy("available_at")
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .first();
      if (!due) return null;
      const [claimed] = await trx("notification_jobs")
        .where({ id: due.id })
        .update({
          status: "SENDING",
          attempts: due.attempts + 1,
          lock_token: randomUUID(),
          locked_until: trx.raw("now() + (? * interval '1 millisecond')", [
            leaseMs,
          ]),
        })
        .returning("*");
      return claimed;
    });
    if (!job) return { idle: true };
    const owned = () =>
      db("notification_jobs").where({
        id: job.id,
        status: "SENDING",
        lock_token: job.lock_token,
      });
    try {
      const booking = await db("bookings")
        .where({ id: job.booking_id, user_id: job.recipient_ref })
        .first();
      if (!booking) {
        const error = new Error("BOOKING_NOT_FOUND");
        error.definitelyNotSent = true;
        throw error;
      }
      await transport.send({ job, booking, idempotencyKey: job.id });
    } catch (error) {
      const definite = error.definitelyNotSent === true;
      await owned().update({
        status: definite ? "FAILED" : "UNKNOWN",
        lock_token: null,
        locked_until: null,
        last_error_code: definite
          ? "SEND_NOT_ACCEPTED"
          : "SEND_OUTCOME_UNKNOWN",
        available_at: db.raw("now() + (? * interval '1 second')", [
          Math.min(3600, 2 ** job.attempts),
        ]),
      });
      metrics?.increment(`notification.${definite ? "failed" : "unknown"}`);
      return { sent: false, unknown: !definite };
    }
    // Outside catch: failure to persist SENT after external success must NOT be
    // classified as a send failure/retry. Lease recovery will mark it UNKNOWN.
    const changed = await owned().update({
      status: "SENT",
      sent_at: db.fn.now(),
      lock_token: null,
      locked_until: null,
      last_error_code: null,
    });
    metrics?.increment(`notification.${changed ? "sent" : "lost_lease"}`);
    return { sent: Boolean(changed) };
  }
  return { tick };
}
module.exports = { createNotificationSender, createLogTransport };
