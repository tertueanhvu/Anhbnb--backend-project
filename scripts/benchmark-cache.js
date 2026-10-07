const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const request = require("supertest");
const { db, closeDatabase } = require("../src/db/postgres");
const { getEnv } = require("../src/config/env");
const { createApp } = require("../src/app");
const { createApiRouter } = require("../src/routes");
const { bookingFixture } = require("../tests/helpers/booking-fixture");
const { testRedis } = require("../tests/helpers/redis");
const { createSearchClient } = require("../src/infrastructure/search/client");
const {
  indexTemplate,
  createPropertyIndex,
} = require("../src/infrastructure/search/property-index");
const {
  createOutboxRepository,
} = require("../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../src/modules/catalog/catalog-write.service");
const { createSearchIndexer } = require("../src/workers/search-indexer");
const { createEnvelope } = require("../src/modules/events/event-envelope");

async function main() {
  const env = getEnv(),
    prefix = `benchmark-${randomUUID()}`,
    topic = `${prefix}.catalog.events.v1`;
  const indexName = `${prefix}-index`,
    alias = `${prefix}-read`;
  const fixture = await bookingFixture(db, env),
    ctx = await testRedis(env.redisUrl);
  const client = createSearchClient({
    url: env.elasticsearchUrl,
    timeoutMs: 10000,
  });
  let router;
  const events = [];
  try {
    await client.request("PUT", `/${indexName}`, indexTemplate);
    await client.request("POST", "/_aliases", {
      actions: [{ add: { index: indexName, alias, is_write_index: true } }],
    });
    router = createApiRouter({
      env: {
        ...env,
        searchBackend: "es",
        elasticsearchIndex: alias,
        kafkaTopicPrefix: prefix,
        redisNamespace: ctx.namespace,
        rateLimit: { ...env.rateLimit, search: 10000 },
      },
    });
    const { redis, cache, metrics } = router.runtimeServices;
    if (redis.client.status !== "ready")
      await new Promise((resolve) => redis.client.once("ready", resolve));
    const indexer = createSearchIndexer({
      db,
      cache,
      index: createPropertyIndex({ client, index: alias }),
    });
    const writer = createCatalogWriteService({
      db,
      outbox: createOutboxRepository(),
    });
    const event = await writer.repairProperty(fixture.propertyId);
    events.push(event.event_id);
    await indexer.handle(event);
    const app = createApp({ apiRouter: router });
    async function fresh() {
      for (let partition = 0; partition < 3; partition += 1) {
        const probe = createEnvelope({
          aggregateType: "catalog",
          aggregateId: randomUUID(),
          version: 1,
          eventType: "CatalogFreshnessProbe",
          data: { partition, partition_count: 3 },
        });
        events.push(probe.event_id);
        await indexer.handle(probe, {
          topic,
          partition,
          offset: String(Date.now()),
        });
      }
    }
    const workloads = [
      {
        name: "property",
        kind: "property",
        scope: fixture.propertyId,
        path: `/api/v1/properties/${fixture.propertyId}`,
      },
      {
        name: "reference",
        kind: "reference",
        scope: "amenities",
        path: "/api/v1/amenities",
      },
      {
        name: "search:es",
        kind: "search",
        scope: "es",
        path: "/api/v1/properties",
        query: { q: "Redis Test Hotel" },
      },
    ];
    const results = [];
    const percentile = (values, q) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
    for (const workload of workloads) {
      await fresh();
      const execute = async () => {
        const started = performance.now();
        const response = await request(app)
          .get(workload.path)
          .query(workload.query || {});
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return { ms: performance.now() - started, data: response.body.data };
      };
      const cold = [],
        warm = [];
      let expected;
      const before = metrics.snapshot();
      for (let n = 0; n < 10; n += 1) {
        await cache.invalidate(workload.kind, workload.scope);
        const result = await execute();
        cold.push(result.ms);
        expected = result.data;
      }
      const middle = metrics.snapshot();
      for (let n = 0; n < 50; n += 1) {
        const result = await execute();
        warm.push(result.ms);
        assert.deepEqual(result.data, expected);
      }
      const after = metrics.snapshot(),
        key = `cache.${workload.kind}`;
      const delta = (a, b, metric) => (a[metric] || 0) - (b[metric] || 0);
      const coldCalls = delta(middle, before, `${key}.source_calls`),
        warmCalls = delta(after, middle, `${key}.source_calls`);
      const hitRate = delta(after, middle, `${key}.hit`) / 50;
      const sourceReduction = 1 - warmCalls / 50 / (coldCalls / 10);
      assert.ok(hitRate >= 0.8 && sourceReduction >= 0.8);
      results.push({
        workload: workload.name,
        coldP50Ms: percentile(cold, 0.5),
        coldP95Ms: percentile(cold, 0.95),
        warmP50Ms: percentile(warm, 0.5),
        warmP95Ms: percentile(warm, 0.95),
        hitRate,
        sourceReduction,
        coldSourceCalls: coldCalls,
        warmSourceCalls: warmCalls,
      });
    }
    // Search discovery is cached; current PostgreSQL inventory must still win.
    const stay = {
      q: "Redis Test Hotel",
      checkIn: fixture.checkIn,
      checkOut: fixture.checkOut,
      adults: 2,
      roomQuantity: 1,
    };
    assert.equal(
      (await request(app).get("/api/v1/properties").query(stay)).body.data
        .length,
      1,
    );
    await db("room_availability")
      .where({ room_id: fixture.roomId })
      .update({ status: "CLOSED" });
    assert.equal(
      (await request(app).get("/api/v1/properties").query(stay)).body.data
        .length,
      0,
    );
    console.log(
      JSON.stringify(
        {
          dataset:
            "isolated single-property fixture; repeated requests, not a production load test",
          results,
          datedAvailabilityRequoted: true,
        },
        null,
        2,
      ),
    );
  } finally {
    router?.close();
    await ctx.cleanup();
    await client.request("DELETE", `/${indexName}`).catch((error) => {
      if (error.status !== 404) throw error;
    });
    await db("consumer_inbox").whereIn("event_id", events).del();
    await db("search_projection_progress").where({ topic }).del();
    await db("outbox_events").where({ aggregate_id: fixture.propertyId }).del();
    await db("catalog_versions")
      .where({ property_id: fixture.propertyId })
      .del();
    await fixture.cleanup();
  }
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
