const { randomUUID } = require("node:crypto");
const request = require("supertest");
const { db, closeDatabase } = require("../../src/db/postgres");
const { getEnv } = require("../../src/config/env");
const { bookingFixture } = require("../helpers/booking-fixture");
const { testRedis } = require("../helpers/redis");
const { createApp } = require("../../src/app");
const { createApiRouter } = require("../../src/routes");
const {
  createSearchClient,
} = require("../../src/infrastructure/search/client");
const {
  createPropertyIndex,
  indexTemplate,
} = require("../../src/infrastructure/search/property-index");
const { createSearchIndexer } = require("../../src/workers/search-indexer");
const { createEnvelope } = require("../../src/modules/events/event-envelope");
const {
  createOutboxRepository,
} = require("../../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../../src/modules/catalog/catalog-write.service");
const {
  createBulkQuoteService,
} = require("../../src/modules/availability/bulk-quote.service");
const {
  createBulkQuoteRepository,
} = require("../../src/modules/availability/bulk-quote.repository");
const { createDomainServices } = require("../../src/runtime/domain-services");
const { createFreshnessGate } = require("../../src/modules/search/freshness");
const { addDays } = require("../../src/shared/dates");

describe.runIf(process.env.SEARCH_INTEGRATION === "true")(
  "ES projection, geo and canonical bulk quote (isolated index)",
  () => {
    const baseEnv = getEnv(),
      prefix = `anhbnb-test-${randomUUID()}`;
    const indexName = `${prefix}-index`,
      alias = `${prefix}-read`,
      topic = `${prefix}.catalog.events.v1`;
    const client = createSearchClient({
      url: baseEnv.elasticsearchUrl,
      timeoutMs: 5000,
      apiKey: baseEnv.elasticsearchApiKey,
    });
    const index = createPropertyIndex({ client, index: alias });
    const eventIds = [],
      extraRooms = [];
    let fixture, ctx, router, app, env, indexer, snapshot;
    async function fresh() {
      for (let partition = 0; partition < 3; partition += 1) {
        const event = createEnvelope({
          aggregateType: "catalog",
          aggregateId: randomUUID(),
          version: 1,
          eventType: "CatalogFreshnessProbe",
          data: { partition, partition_count: 3 },
        });
        eventIds.push(event.event_id);
        await indexer.handle(event, {
          topic,
          partition,
          offset: String(Date.now()),
        });
      }
    }
    beforeAll(async () => {
      // bookingFixture enforces *_test DB. ES resources and Redis keys use a UUID.
      fixture = await bookingFixture(db, baseEnv);
      ctx = await testRedis(baseEnv.redisUrl);
      await client.request("PUT", `/${indexName}`, indexTemplate);
      await client.request("POST", "/_aliases", {
        actions: [{ add: { index: indexName, alias, is_write_index: true } }],
      });
      env = {
        ...baseEnv,
        searchBackend: "es",
        elasticsearchIndex: alias,
        kafkaTopicPrefix: prefix,
        redisNamespace: ctx.namespace,
      };
      router = createApiRouter({ env });
      app = createApp({ apiRouter: router });
      if (router.runtimeServices.redis.client.status !== "ready")
        await new Promise((resolve) =>
          router.runtimeServices.redis.client.once("ready", resolve),
        );
      indexer = createSearchIndexer({
        db,
        index,
        cache: router.runtimeServices.cache,
      });
      const writer = createCatalogWriteService({
        db,
        outbox: createOutboxRepository(),
      });
      snapshot = await writer.updateProperty(fixture.propertyId, {
        latitude: 16.0471,
        longitude: 108.2499,
        name: "Beach Test Hotel",
      });
      eventIds.push(snapshot.event_id);
      await indexer.handle(snapshot);
      await fresh();
    }, 30000);
    afterAll(async () => {
      router?.close();
      if (ctx) await ctx.cleanup();
      // Only this test's exact UUID index, never the live alias or a wildcard.
      await client.request("DELETE", `/${indexName}`).catch((error) => {
        if (error.status !== 404) throw error;
      });
      await db("consumer_inbox").whereIn("event_id", eventIds).del();
      await db("consumer_failures").where({ topic }).del();
      await db("search_projection_progress").where({ topic }).del();
      if (fixture) {
        await db("outbox_events")
          .where({ aggregate_id: fixture.propertyId })
          .del();
        await db("catalog_versions")
          .where({ property_id: fixture.propertyId })
          .del();
        await db("room_availability").whereIn("room_id", extraRooms).del();
        await db("rooms").whereIn("id", extraRooms).del();
        await fixture.cleanup();
      }
      await closeDatabase();
    }, 30000);

    it("searches geo/text and keeps discovery cache separate from current date prices", async () => {
      const query = {
        q: "Beach",
        lat: 16.0471,
        lon: 108.2499,
        radiusKm: 2,
        sort: "distance",
      };
      const first = await request(app).get("/api/v1/properties").query(query);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data.map((row) => row.id)).toEqual([
        fixture.propertyId,
      ]);
      expect(
        (
          await request(app)
            .get("/api/v1/properties")
            .query({ ...query, lat: 10 })
        ).body.data,
      ).toEqual([]);
      const stay = {
        ...query,
        checkIn: fixture.checkIn,
        checkOut: fixture.checkOut,
        adults: 2,
        children: 0,
        roomQuantity: 1,
      };
      expect(
        (await request(app).get("/api/v1/properties").query(stay)).body.data[0]
          .roomTypes[0].price.total,
      ).toBe(1000000);
      await db("room_availability")
        .where({ room_id: fixture.roomId })
        .update({ price: 700000 });
      const cached = await request(app).get("/api/v1/properties").query(stay);
      expect(cached.body.data[0].roomTypes[0].price.total).toBe(1400000);
      expect(
        router.runtimeServices.metrics.snapshot()["cache.search.hit"],
      ).toBeGreaterThan(0);
      await db("room_availability")
        .where({ room_id: fixture.roomId })
        .update({ price: 500000 });
    });

    it("bulk quote matches single-room engine, including fragmented physical inventory", async () => {
      const repository = createBulkQuoteRepository(db),
        calls = [];
      const bulk = createBulkQuoteService({
        repository: {
          read: (...args) => {
            calls.push(args);
            return repository.read(...args);
          },
        },
        env,
      });
      const single = await createDomainServices({
        db,
        env,
      }).availabilityService.quoteSelection(fixture.body);
      const grouped = await bulk.quote([fixture.propertyId], fixture.body);
      expect(grouped.get(fixture.roomTypeId).subtotal).toBe(single.subtotal);
      expect(grouped.get(fixture.roomTypeId).nightly).toEqual(single.nightly);
      expect(calls).toHaveLength(1);
      const other = randomUUID();
      extraRooms.push(other);
      await db("rooms").insert({
        id: other,
        property_id: fixture.propertyId,
        room_type_id: fixture.roomTypeId,
        room_code: "R2",
      });
      await db("room_availability").insert([
        {
          room_id: other,
          stay_date: fixture.checkIn,
          price: 500000,
          status: "CLOSED",
        },
        {
          room_id: other,
          stay_date: addDays(fixture.checkIn, 1),
          price: 500000,
        },
      ]);
      await db("room_availability")
        .where({
          room_id: fixture.roomId,
          stay_date: addDays(fixture.checkIn, 1),
        })
        .update({ status: "CLOSED" });
      const fragmented = (
        await bulk.quote([fixture.propertyId], fixture.body)
      ).get(fixture.roomTypeId);
      expect(fragmented.nightly.map((night) => night.openRooms)).toEqual([
        1, 1,
      ]);
      expect(fragmented.available).toBe(false);
      expect(fragmented.bookableRooms).toBe(0);
      await db("room_availability")
        .where({ room_id: fixture.roomId })
        .update({ status: "OPEN" });
      await db("room_availability").where({ room_id: other }).del();
      await db("rooms").where({ id: other }).del();
    });

    it("ES success followed by Redis failure remains retryable; older replay cannot resurrect a tombstone", async () => {
      const failingCache = {
        invalidate: vi
          .fn()
          .mockRejectedValueOnce(new Error("Redis down"))
          .mockResolvedValue(undefined),
      };
      const handler = createSearchIndexer({ db, index, cache: failingCache });
      const next = createEnvelope({
        aggregateType: "catalog",
        aggregateId: fixture.propertyId,
        version: 2,
        eventType: "PropertyUpserted",
        data: {
          property_id: fixture.propertyId,
          snapshot: {
            ...snapshot.data.snapshot,
            version: 2,
            name: "Updated Beach Hotel",
          },
        },
      });
      eventIds.push(next.event_id);
      await expect(handler.handle(next)).rejects.toThrow("Redis down");
      expect(
        await db("consumer_inbox").where({
          consumer_name: handler.name,
          event_id: next.event_id,
        }),
      ).toHaveLength(0);
      await handler.handle(next);
      expect(failingCache.invalidate).toHaveBeenCalledTimes(2);
      const deleted = createEnvelope({
        aggregateType: "catalog",
        aggregateId: fixture.propertyId,
        version: 3,
        eventType: "PropertyDeleted",
        data: {
          property_id: fixture.propertyId,
          snapshot: {
            propertyId: fixture.propertyId,
            version: 3,
            active: false,
            deleted: true,
            updatedAt: next.occurred_at,
          },
        },
      });
      eventIds.push(deleted.event_id);
      await handler.handle(deleted);
      await index.apply(snapshot);
      expect(
        (await client.request("GET", `/${alias}/_doc/${fixture.propertyId}`))
          ._source.deleted,
      ).toBe(true);
    });

    it("does not call cache if one partition is stale or an unresolved DLQ record exists", async () => {
      const gate = createFreshnessGate({ db, topic });
      await fresh();
      expect(await gate.check()).toBeTruthy();
      await db("search_projection_progress")
        .where({ topic, partition: 1 })
        .update({ source_time: new Date(Date.now() - 61000) });
      await expect(gate.check()).rejects.toMatchObject({
        code: "SEARCH_NOT_READY",
      });
      await fresh();
      await db("consumer_failures").insert({
        failure_id: randomUUID(),
        consumer_name: "search-indexer-v1",
        topic,
        partition: 0,
        source_offset: 0,
        error_code: "TEST_FAILURE",
        attempts: 6,
      });
      await expect(gate.check()).rejects.toMatchObject({
        code: "SEARCH_NOT_READY",
      });
      const api = await request(app).get("/api/v1/properties");
      expect(api.status).toBe(503);
      await db("consumer_failures").where({ topic }).del();
    });
  },
);
