const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { getEnv } = require("../../src/config/env");
const { db, closeDatabase } = require("../../src/db/postgres");
const { assertTestDatabase } = require("../helpers/redis");
const {
  createKafka,
  createReliableProducer,
} = require("../../src/infrastructure/kafka/client");
const {
  startEventConsumer,
} = require("../../src/infrastructure/kafka/consumer");
const { createDeadLetterSink } = require("../../src/infrastructure/kafka/dlq");
const {
  createInboxRepository,
} = require("../../src/modules/events/inbox.repository");
const { createEnvelope } = require("../../src/modules/events/event-envelope");

describe.runIf(process.env.KAFKA_INTEGRATION === "true")(
  "real Kafka duplicate/restart/DLQ integration (isolated topics)",
  () => {
    const env = getEnv(),
      prefix = `anhbnb-test-${randomUUID()}`;
    const topic = `${prefix}.booking.events.v1`,
      dlqTopic = `${prefix}.events.dlq.v1`;
    const kafka = createKafka(env, prefix),
      admin = kafka.admin(),
      producer = createReliableProducer(kafka);
    const inbox = createInboxRepository(db),
      consumers = [],
      ids = [];
    const name = `test-${randomUUID()}`;
    let effects = 0;
    const handler = {
      name,
      topics: ["booking"],
      handle: (event) =>
        inbox.transaction(name, event.event_id, async () => {
          effects += 1;
        }),
    };
    const deadLetter = createDeadLetterSink({ db, producer, topic: dlqTopic });
    const start = () =>
      startEventConsumer({
        kafka,
        handler,
        deadLetter,
        retryMax: 0,
        topicPrefix: prefix,
        groupPrefix: prefix,
      });
    beforeAll(async () => {
      assertTestDatabase(env.databaseUrl);
      await admin.connect();
      await producer.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [topic, dlqTopic].map((topic) => ({
          topic,
          numPartitions: 3,
          replicationFactor: 1,
        })),
      });
    }, 30000);
    afterAll(async () => {
      await Promise.all(consumers.map((consumer) => consumer.disconnect()));
      await producer.disconnect();
      // Exact UUID-scoped test resources only. Never reset dev consumer offsets.
      await admin.deleteGroups([`${prefix}-${name}`]).catch(() => {});
      await admin.deleteTopics({ topics: [topic, dlqTopic] });
      await admin.disconnect();
      await db("consumer_inbox").where({ consumer_name: name }).del();
      await db("consumer_failures").where({ consumer_name: name }).del();
      await closeDatabase();
    }, 30000);
    it("two workers consume duplicate Kafka deliveries once; poison record is durably handed off", async () => {
      consumers.push(await start(), await start());
      const event = createEnvelope({
        aggregateType: "booking",
        aggregateId: randomUUID(),
        version: 1,
        eventType: "BookingHeld",
        data: {},
      });
      ids.push(event.event_id);
      const message = {
        key: event.aggregate_id,
        value: JSON.stringify(event),
        partition: 0,
      };
      await producer.send({
        topic,
        acks: -1,
        messages: [
          message,
          message,
          { key: event.aggregate_id, value: "malformed", partition: 0 },
        ],
      });
      for (let i = 0; i < 150; i += 1) {
        if (
          (await db("consumer_failures").where({ consumer_name: name })).length
        )
          break;
        await delay(100);
      }
      expect(effects).toBe(1);
      expect(
        await db("consumer_inbox").where({ consumer_name: name }),
      ).toHaveLength(1);
      const failures = await db("consumer_failures").where({
        consumer_name: name,
      });
      expect(failures).toHaveLength(1);
      expect(failures[0].source_offset).toBe("2");
      for (const consumer of consumers) await consumer.disconnect();
      consumers.length = 0;
      consumers.push(await start());
      await producer.send({ topic, acks: -1, messages: [message] });
      for (let i = 0; i < 100; i += 1) {
        const offsets = await admin.fetchOffsets({
          groupId: `${prefix}-${name}`,
          topics: [topic],
        });
        if (offsets[0].partitions.find((p) => p.partition === 0).offset === "4")
          break;
        await delay(100);
      }
      expect(effects).toBe(1);
      const offsets = await admin.fetchOffsets({
        groupId: `${prefix}-${name}`,
        topics: [topic],
      });
      expect(offsets[0].partitions.find((p) => p.partition === 0).offset).toBe(
        "4",
      );
    }, 45000);
  },
);
