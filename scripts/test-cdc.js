const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { getEnv } = require("../src/config/env");
const { db, closeDatabase } = require("../src/db/postgres");
const { createKafka } = require("../src/infrastructure/kafka/client");
const { validateEnvelope } = require("../src/modules/events/event-envelope");
const {
  createOutboxRepository,
} = require("../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../src/modules/catalog/catalog-write.service");
const { eventContext } = require("../src/modules/events/event-context");

async function main() {
  const env = getEnv();
  if (
    env.nodeEnv !== "development" ||
    new URL(env.databaseUrl).pathname !== "/hotel_booking_dev"
  )
    throw new Error("CDC smoke is for the local Phase 2 development DB only");
  const property = await db("properties")
    .where({ status: "ACTIVE" })
    .first("id");
  if (!property)
    throw new Error(
      "Seed the fresh development catalog explicitly before CDC smoke",
    );
  const groupId = `anhbnb-cdc-smoke-${randomUUID()}`;
  const consumer = createKafka(env, "anhbnb-cdc-smoke").consumer({
    groupId,
    allowAutoTopicCreation: false,
  });
  let joined = false;
  const observed = new Map();
  consumer.on(consumer.events.GROUP_JOIN, () => {
    joined = true;
  });
  try {
    await consumer.connect();
    await consumer.subscribe({
      topic: "anhbnb.catalog.events.v1",
      fromBeginning: false,
    });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        if (!message.value) return;
        let value = JSON.parse(message.value.toString());
        if (typeof value === "string") value = JSON.parse(value);
        const event = validateEnvelope(value);
        observed.set(event.event_id, {
          event,
          key: message.key.toString(),
          topic,
          partition,
          offset: message.offset,
        });
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
    for (let attempt = 0; attempt < 100 && !joined; attempt += 1)
      await delay(100);
    assert(joined, "Consumer must join before producing the smoke snapshot");
    const writer = createCatalogWriteService({
      db,
      outbox: createOutboxRepository(),
    });
    const event = await eventContext.run(
      { requestId: `cdc-smoke-${randomUUID()}` },
      () => writer.repairProperty(property.id),
    );
    for (
      let attempt = 0;
      attempt < 150 && !observed.has(event.event_id);
      attempt += 1
    )
      await delay(200);
    const received = observed.get(event.event_id);
    assert(received, "No matching event in Kafka after 30 seconds");
    assert.equal(received.key, property.id);
    assert.equal(received.event.aggregate_version, event.aggregate_version);
    assert.equal(received.event.request_id, event.request_id);
    console.log(
      JSON.stringify(
        {
          result: "DB -> outbox -> WAL -> Debezium -> Kafka verified",
          eventId: event.event_id,
          topic: received.topic,
          partition: received.partition,
          offset: received.offset,
        },
        null,
        2,
      ),
    );
  } finally {
    await consumer.disconnect();
  }
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
