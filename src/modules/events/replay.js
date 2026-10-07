const Joi = require("joi");
const { validateEnvelope } = require("./event-envelope");
async function replayEvent({
  db,
  handlers,
  consumerName,
  eventId,
  confirm = false,
  allowNotification = false,
  now = Date.now(),
}) {
  if (!confirm || Joi.string().uuid().required().validate(eventId).error)
    throw new Error("REPLAY_REQUIRES_EVENT_ID_AND_CONFIRM");
  const handler = Object.values(handlers).find(
    (item) => item.name === consumerName,
  );
  if (!handler) throw new Error("REPLAY_HANDLER_NOT_ALLOWED");
  if (handler.name === "notification-v1" && !allowNotification)
    throw new Error("NOTIFICATION_REPLAY_REQUIRES_EXPLICIT_OPT_IN");
  const row = await db("outbox_events").where({ event_id: eventId }).first();
  if (!row) throw new Error("REPLAY_OUTBOX_NOT_FOUND");
  const age = now - new Date(row.occurred_at).getTime();
  if (age > 90 * 86400000 || age < -60000)
    throw new Error("REPLAY_OUTSIDE_DEDUP_WINDOW");
  const event = validateEnvelope(row.payload);
  if (
    event.event_id !== eventId ||
    !handler.topics.includes(event.aggregate_type)
  )
    throw new Error("REPLAY_EVENT_HANDLER_MISMATCH");
  // Target ONE handler directly. Never republish onto domain topics/fan out email.
  const result = await handler.handle(event, { replay: true });
  await db("consumer_failures")
    .where({ consumer_name: handler.name, event_id: eventId, status: "OPEN" })
    .update({ status: "RESOLVED", resolved_at: db.fn.now() });
  return { eventId, consumerName, ...result };
}
module.exports = { replayEvent };
