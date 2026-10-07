const { setTimeout: delay } = require("node:timers/promises");
const { validateEnvelope } = require("../../modules/events/event-envelope");

function decodeEvent(message) {
  if (!message.value || message.value.length > 1024 * 1024)
    throw new Error("INVALID_EVENT_SIZE");
  let value = JSON.parse(message.value.toString("utf8"));
  if (typeof value === "string") value = JSON.parse(value);
  const event = validateEnvelope(value);
  if (message.key?.toString() !== event.aggregate_id)
    throw new Error("EVENT_KEY_MISMATCH");
  return event;
}

function createBatchHandler({
  consumer,
  handler,
  deadLetter,
  retryMax = 5,
  metrics,
  wait = delay,
  random = Math.random,
}) {
  return async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
    const active = () => isRunning() && !isStale();
    for (const message of batch.messages) {
      if (!active()) return;
      const record = {
        topic: batch.topic,
        partition: batch.partition,
        message,
      };
      let event,
        completed = false;
      for (let attempt = 0; attempt <= retryMax; attempt += 1) {
        if (!active()) return;
        try {
          event = decodeEvent(message);
          if (
            !handler.topics.some((kind) =>
              record.topic.endsWith(`.${kind}.events.v1`),
            )
          )
            throw new Error("EVENT_TOPIC_MISMATCH");
          if (!record.topic.endsWith(`.${event.aggregate_type}.events.v1`))
            throw new Error("EVENT_DOMAIN_MISMATCH");
          await handler.handle(event, {
            topic: record.topic,
            partition: record.partition,
            offset: message.offset,
          });
          completed = true;
          break;
        } catch (error) {
          if (!active()) return;
          if (attempt === retryMax) {
            await deadLetter({
              consumerName: handler.name,
              record,
              event,
              error,
              attempts: attempt + 1,
            });
            completed = true;
            break;
          }
          metrics?.increment(`consumer.${handler.name}.retry`);
          // This partition stays blocked on its current record; other partitions
          // may progress. Heartbeat every <=1s during bounded retry backoff.
          let remaining =
            Math.min(16000, 1000 * 2 ** attempt) * (0.8 + random() * 0.4);
          while (remaining > 0 && active()) {
            const step = Math.min(1000, remaining);
            await wait(step);
            await heartbeat();
            remaining -= step;
          }
        }
      }
      if (!completed || !active()) return;
      // Never advance over a failed/in-flight record in the same partition.
      await consumer.commitOffsets([
        {
          topic: batch.topic,
          partition: batch.partition,
          offset: (BigInt(message.offset) + 1n).toString(),
        },
      ]);
      resolveOffset(message.offset);
      await heartbeat();
      metrics?.increment(`consumer.${handler.name}.processed`);
    }
  };
}

async function startEventConsumer({
  kafka,
  handler,
  deadLetter,
  retryMax,
  metrics,
  topicPrefix = "anhbnb",
  groupPrefix = "anhbnb",
  onCrash,
}) {
  const consumer = kafka.consumer({
    groupId: `${groupPrefix}-${handler.name}`,
    allowAutoTopicCreation: false,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    retry: { retries: 5 },
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) onCrash?.(payload.error);
  });
  try {
    await consumer.connect();
    await consumer.subscribe({
      topics: handler.topics.map((kind) => `${topicPrefix}.${kind}.events.v1`),
      fromBeginning: true,
    });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: 3,
      eachBatch: createBatchHandler({
        consumer,
        handler,
        deadLetter,
        retryMax,
        metrics,
      }),
    });
    return consumer;
  } catch (error) {
    await consumer.disconnect().catch(() => {});
    throw error;
  }
}
module.exports = { decodeEvent, createBatchHandler, startEventConsumer };
