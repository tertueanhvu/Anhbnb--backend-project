const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const { bookingFixture } = require("../helpers/booking-fixture");
const {
  createKafka,
  createReliableProducer,
} = require("../../src/infrastructure/kafka/client");
const {
  createSearchClient,
} = require("../../src/infrastructure/search/client");
const {
  indexTemplate,
  createPropertyIndex,
} = require("../../src/infrastructure/search/property-index");
const {
  createOutboxRepository,
} = require("../../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../../src/modules/catalog/catalog-write.service");
const { createSearchIndexer } = require("../../src/workers/search-indexer");
const { createFreshnessGate } = require("../../src/modules/search/freshness");
const { reindexSearch } = require("../../src/modules/search/reindex");

describe.runIf(
  process.env.SEARCH_INTEGRATION === "true" &&
    process.env.KAFKA_INTEGRATION === "true",
)("safe rebuild with isolated Kafka/ES resources", () => {
  const env = getEnv(),
    prefix = `rebuild-test-${randomUUID()}`;
  const topic = `${prefix}.catalog.events.v1`,
    alias = `${prefix}-read`;
  const kafka = createKafka(env, prefix),
    admin = kafka.admin(),
    producer = createReliableProducer(kafka);
  const client = createSearchClient({
    url: env.elasticsearchUrl,
    timeoutMs: 10000,
  });
  const writer = createCatalogWriteService({
    db,
    outbox: createOutboxRepository(),
  });
  const indices = [],
    createdRegistries = [],
    createdEvents = [],
    seen = new Set();
  const cache = { invalidate: vi.fn().mockResolvedValue(undefined) };
  let fixture,
    stop = false,
    pump,
    initialState,
    first;
  beforeAll(async () => {
    fixture = await bookingFixture(db, env); // Refuses any DB not ending _test.
    initialState = await db("search_projection_state").first();
    for (const row of await db("outbox_events").select("event_id"))
      seen.add(row.event_id);
    const missing = await db("properties as p")
      .leftJoin("catalog_versions as v", "v.property_id", "p.id")
      .whereNull("v.property_id")
      .select("p.id");
    for (const row of missing) {
      createdRegistries.push(row.id);
      const event = await writer.repairProperty(row.id);
      createdEvents.push(event.event_id);
      if (row.id === fixture.propertyId) first = event;
    }
    await admin.connect();
    await producer.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 3, replicationFactor: 1 }],
      waitForLeaders: true,
    });
    const old = `${prefix}-old`;
    indices.push(old);
    await client.request("PUT", `/${old}`, indexTemplate);
    await client.request("POST", "/_aliases", {
      actions: [{ add: { index: old, alias, is_write_index: true } }],
    });
    // Prove a completed LIVE inbox cannot suppress the rebuild's own snapshot.
    await createSearchIndexer({
      db,
      index: createPropertyIndex({ client, index: alias }),
      cache,
    }).handle(first);
    // Test transport only: *_test is deliberately NOT captured by the dev CDC
    // connector. The full dev smoke separately exercises real WAL/Debezium.
    pump = (async () => {
      while (!stop) {
        const rows = await db("outbox_events")
          .where({ aggregate_type: "catalog" })
          .orderBy("occurred_at");
        for (const row of rows)
          if (!seen.has(row.event_id)) {
            await producer.send({
              topic,
              acks: -1,
              messages: [
                { key: row.aggregate_id, value: JSON.stringify(row.payload) },
              ],
            });
            seen.add(row.event_id);
            createdEvents.push(row.event_id);
          }
        await delay(30);
      }
    })();
  }, 30000);
  afterAll(async () => {
    stop = true;
    await pump;
    for (const index of indices)
      await client.request("DELETE", `/${index}`).catch((error) => {
        if (error.status !== 404) throw error;
      });
    await admin.deleteTopics({ topics: [topic] });
    await producer.disconnect();
    await admin.disconnect();
    await db("search_rebuild_runs").where({ alias }).del();
    await db("consumer_inbox").whereIn("event_id", createdEvents).del();
    await db("outbox_events").whereIn("event_id", createdEvents).del();
    await db("catalog_versions")
      .whereIn("property_id", createdRegistries)
      .del();
    if (initialState)
      await db("search_projection_state")
        .where({ singleton: true })
        .update(initialState);
    await fixture?.cleanup();
    await closeDatabase();
  }, 30000);

  it("catches a concurrent commit, ignores live inbox, swaps atomically and retains old index", async () => {
    const target = `${prefix}-next`;
    indices.push(target);
    const result = await reindexSearch({
      db,
      client,
      kafka,
      cache,
      target,
      alias,
      topic,
      afterBackfill: async () => {
        const event = await writer.updateProperty(fixture.propertyId, {
          name: "Changed during rebuild",
        });
        createdEvents.push(event.event_id);
      },
    });
    const doc = await client.request(
      "GET",
      `/${alias}/_doc/${fixture.propertyId}`,
    );
    expect(doc._source.name).toBe("Changed during rebuild");
    expect(doc._version).toBe(2);
    expect(result.oldIndices).toEqual([indices[0]]);
    expect(
      Object.keys(await client.request("GET", `/_alias/${alias}`)),
    ).toEqual([target]);
    expect(await client.request("HEAD", `/${indices[0]}`)).toBeDefined();
    await expect(
      createFreshnessGate({ db, topic }).check(),
    ).rejects.toMatchObject({ code: "SEARCH_NOT_READY" });
    expect(
      (await db("search_rebuild_runs").where({ id: result.runId }).first())
        .status,
    ).toBe("COMPLETED");
  }, 90000);

  it("keeps search fail-closed after alias success/cache failure, then recovers via a NEW rebuild", async () => {
    const failed = `${prefix}-failed`;
    indices.push(failed);
    await expect(
      reindexSearch({
        db,
        client,
        kafka,
        cache: {
          invalidate: async () => {
            throw new Error("Redis down");
          },
        },
        target: failed,
        alias,
        topic,
      }),
    ).rejects.toThrow("Redis down");
    expect((await db("search_projection_state").first()).maintenance).toBe(
      true,
    );
    expect(
      Object.keys(await client.request("GET", `/_alias/${alias}`)),
    ).toEqual([failed]);
    const recovery = `${prefix}-recovered`;
    indices.push(recovery);
    await reindexSearch({
      db,
      client,
      kafka,
      cache,
      target: recovery,
      alias,
      topic,
    });
    expect((await db("search_projection_state").first()).maintenance).toBe(
      false,
    );
    await expect(
      reindexSearch({
        db,
        client,
        kafka,
        cache,
        target: recovery,
        alias,
        topic,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      Object.keys(await client.request("GET", `/_alias/${alias}`)),
    ).toEqual([recovery]);
  }, 120000);
});
