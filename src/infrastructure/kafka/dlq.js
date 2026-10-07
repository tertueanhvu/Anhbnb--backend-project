const { createHash } = require("node:crypto");
function safeErrorCode(error) {
  // Never copy arbitrary error.message (SQL, HTTP bodies, credentials) to logs/events.
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,60}$/.test(code)
    ? code
    : "CONSUMER_EFFECT_FAILED";
}
function createDeadLetterSink({
  db,
  producer,
  topic = "anhbnb.events.dlq.v1",
  metrics,
}) {
  return async ({ consumerName, record, event, error, attempts }) => {
    const failureId = createHash("sha256")
      .update(
        `${consumerName}:${record.topic}:${record.partition}:${record.message.offset}`,
      )
      .digest("hex");
    const errorCode = safeErrorCode(error);
    // Duplicate DLQ records after a crash are safe; failure_id identifies handoff.
    await producer.send({
      topic,
      acks: -1,
      messages: [
        {
          key: failureId,
          value: JSON.stringify({
            failure_id: failureId,
            consumer_name: consumerName,
            event_id: event?.event_id || null,
            source: {
              topic: record.topic,
              partition: record.partition,
              offset: record.message.offset,
              key_base64: record.message.key?.toString("base64") || null,
              value_base64: record.message.value?.toString("base64") || null,
            },
            attempts,
            error_code: errorCode,
          }),
        },
      ],
    });
    // If DB bookkeeping fails, do not commit the source offset either. This
    // ledger makes a skipped failure visible even after later freshness probes.
    await db("consumer_failures")
      .insert({
        failure_id: failureId,
        consumer_name: consumerName,
        event_id: event?.event_id || null,
        topic: record.topic,
        partition: record.partition,
        source_offset: record.message.offset,
        error_code: errorCode,
        attempts,
      })
      .onConflict("failure_id")
      .ignore();
    metrics?.increment(`consumer.${consumerName}.dlq`);
  };
}
module.exports = { createDeadLetterSink, safeErrorCode };
