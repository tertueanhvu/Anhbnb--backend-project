const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { decodeEvent } = require("../../infrastructure/kafka/consumer");

// A disposable, search-only group. Never shares the live handler inbox and
// never dispatches notification/payment effects. Replays are version-guarded.
async function startRebuildConsumer({ kafka, admin, topic, start, index }) {
  const groupId = `anhbnb-rebuild-${randomUUID()}`;
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
  const next = new Map(start.map((row) => [row.partition, BigInt(row.offset)]));
  const probes = new Map();
  let failure;
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    failure = payload.error;
  });
  await admin.setOffsets({
    groupId,
    topic,
    partitions: start.map(({ partition, offset }) => ({ partition, offset })),
  });
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: 3,
      eachBatch: async ({
        batch,
        heartbeat,
        resolveOffset,
        isRunning,
        isStale,
      }) => {
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || failure) return;
          try {
            const event = decodeEvent(message);
            if (event.aggregate_type !== "catalog")
              throw new Error("INVALID_REBUILD_DOMAIN");
            if (event.event_type === "CatalogFreshnessProbe") {
              if (
                event.data.partition !== batch.partition ||
                event.data.partition_count !== start.length
              )
                throw new Error("INVALID_REBUILD_PROBE_PARTITION");
              probes.set(event.event_id, {
                partition: batch.partition,
                offset: message.offset,
              });
            } else if (event.event_type !== "AmenityChanged") {
              if (
                ![
                  "PropertyUpserted",
                  "PropertyDeleted",
                  "RoomTypeUpserted",
                  "RoomTypeDeleted",
                ].includes(event.event_type)
              )
                throw new Error("INVALID_REBUILD_EVENT");
              await index.apply(event);
            }
            next.set(batch.partition, BigInt(message.offset) + 1n);
            resolveOffset(message.offset);
            await heartbeat();
          } catch (error) {
            failure = error;
            return;
          }
        }
      },
    });
  } catch (error) {
    await consumer.disconnect();
    throw error;
  }
  return {
    groupId,
    async waitFor({ eventIds = [], offsets = [], timeoutMs = 30000 }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (
          eventIds.every((id) => probes.has(id)) &&
          offsets.every((row) => next.get(row.partition) >= BigInt(row.offset))
        )
          return;
        await delay(100);
      }
      throw new Error("REBUILD_CATCHUP_TIMEOUT");
    },
    async close() {
      await consumer.stop();
      await consumer.disconnect();
      // Delete only this invocation's UUID group; no production offsets touched.
      await admin.deleteGroups([groupId]);
    },
  };
}
module.exports = { startRebuildConsumer };
