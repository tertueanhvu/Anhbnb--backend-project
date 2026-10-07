const { randomUUID } = require("node:crypto");
const { list } = require("../../src/modules/properties/property.validator");
const {
  normalizeDiscoveryQuery,
} = require("../../src/modules/properties/public-catalog");
const {
  buildSearchQuery,
} = require("../../src/modules/search/search.repository");
const { createSearchCursor } = require("../../src/modules/search/cursor");
const {
  createSearchService,
} = require("../../src/modules/search/search.service");
const {
  createPropertyIndex,
} = require("../../src/infrastructure/search/property-index");
const { createEnvelope } = require("../../src/modules/events/event-envelope");
const { probeKeys } = require("../../src/modules/search/freshness-probes");

describe("search query/geo/cache contracts", () => {
  it("requires complete geo input, valid bounds and coordinates for distance sort", () => {
    for (const input of [
      { lat: 16 },
      { sort: "distance" },
      { lat: 91, lon: 108, radiusKm: 1 },
      { lat: 16, lon: 108, radiusKm: 0 },
      { lat: 16, lon: 108, radiusKm: 201 },
    ])
      expect(list.query.validate(input).error).toBeDefined();
    expect(
      list.query.validate({
        lat: "16",
        lon: "108",
        radiusKm: "10",
        sort: "distance",
      }).error,
    ).toBeUndefined();
  });
  it("normalizes discovery without user/date/capacity and preserves geo/page distinctions", () => {
    const base = {
      q: "  BEACH  Hotel ",
      amenity: ["WIFI", "POOL", "WIFI"],
      lat: 16,
      lon: 108,
      radiusKm: 10,
    };
    const key = normalizeDiscoveryQuery(base);
    expect(
      normalizeDiscoveryQuery({
        ...base,
        checkIn: "2030-01-01",
        adults: 3,
        userId: "private",
      }),
    ).toEqual(key);
    expect(key.amenity).toEqual(["POOL", "WIFI"]);
    expect(key.q).toBe("beach hotel");
    expect(normalizeDiscoveryQuery({ ...base, lat: 17 })).not.toEqual(key);
    expect(normalizeDiscoveryQuery({ ...base, page: 2 })).not.toEqual(key);
  });
  it("keeps room price/bed/bath predicates inside a single nested query", () => {
    const query = buildSearchQuery(
      normalizeDiscoveryQuery({
        minPrice: 100,
        maxPrice: 200,
        minBedrooms: 2,
        minBathrooms: 1,
        adults: 3,
        lat: 16,
        lon: 108,
        radiusKm: 10,
        sort: "distance",
      }),
    );
    const nested = query.query.bool.filter.find(
      (filter) => filter.nested,
    ).nested;
    expect(nested.query.bool.filter).toContainEqual({
      range: { "roomTypes.basePrice": { gte: 100, lte: 200 } },
    });
    expect(nested.query.bool.filter).toContainEqual({
      range: { "roomTypes.bedCount": { gte: 2 } },
    });
    expect(query.sort[0]._geo_distance.location).toEqual({ lat: 16, lon: 108 });
    expect(JSON.stringify(query)).not.toContain("maxGuests");
  });
  it("signed cursors bind query and index generation", () => {
    const cursor = createSearchCursor("test-key-only"),
      generation = randomUUID(),
      query = normalizeDiscoveryQuery({ q: "beach" });
    const token = cursor.encode({ generation, query, sort: [1, randomUUID()] });
    expect(cursor.decode(token, { generation, query })).toHaveLength(2);
    expect(() =>
      cursor.decode(token, { generation: randomUUID(), query }),
    ).toThrow();
    expect(() =>
      cursor.decode(token, { generation, query: { ...query, q: "different" } }),
    ).toThrow();
    expect(() => cursor.decode(`${token}x`, { generation, query })).toThrow();
  });
  it("checks freshness before cache and always requotes dated candidates", async () => {
    const id = randomUUID(),
      calls = [];
    const service = createSearchService({
      repository: { page: vi.fn() },
      cache: {
        read: async () => {
          calls.push("cache");
          return { ids: [id], total: 1, lastSort: [1, id] };
        },
      },
      freshness: {
        check: async () => {
          calls.push("fresh");
          return "generation";
        },
      },
      loadCatalog: async () => [{ id }],
      quoteCatalog: async () => {
        calls.push("quote");
        return [];
      },
      sortProperties: (items) => items,
    });
    const result = await service.list({
      checkIn: "2030-01-01",
      checkOut: "2030-01-02",
      page: 1,
      limit: 20,
    });
    expect(calls).toEqual(["fresh", "cache", "quote"]);
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });
  it("rejects a dated scan wider than 1000 before claiming an available total", async () => {
    const quoteCatalog = vi.fn();
    const service = createSearchService({
      cache: {
        read: async () => ({
          ids: [randomUUID()],
          total: 1001,
          lastSort: null,
        }),
      },
      freshness: { check: async () => "generation" },
      quoteCatalog,
    });
    await expect(
      service.list({
        checkIn: "2030-01-01",
        checkOut: "2030-01-02",
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "SEARCH_TOO_BROAD" });
    expect(quoteCatalog).not.toHaveBeenCalled();
  });
  it("probe keys cover all three Java-compatible Kafka partitions", () => {
    expect([...probeKeys().keys()].sort()).toEqual([0, 1, 2]);
    expect(probeKeys()).toEqual(probeKeys());
  });
});
describe("ES external version and visibility barriers", () => {
  function event() {
    const id = randomUUID();
    return createEnvelope({
      aggregateType: "catalog",
      aggregateId: id,
      version: 2,
      eventType: "PropertyDeleted",
      data: {
        snapshot: {
          propertyId: id,
          version: 2,
          active: false,
          deleted: true,
          updatedAt: "2026-10-06T00:00:00.000Z",
        },
      },
    });
  }
  it("uses external versions and requires the live alias; equal replay refreshes before completion", async () => {
    const one = event(),
      calls = [];
    const client = {
      request: vi.fn(async (method, path) => {
        calls.push([method, path]);
        if (method === "PUT") {
          const error = new Error();
          error.status = 409;
          throw error;
        }
        if (method === "GET")
          return { _version: 2, _source: one.data.snapshot };
      }),
    };
    expect(await createPropertyIndex({ client }).apply(one)).toEqual({
      updated: false,
    });
    expect(calls[0][1]).toContain(
      "version_type=external&refresh=wait_for&require_alias=true",
    );
    expect(calls.at(-1)).toEqual(["POST", "/properties_read/_refresh"]);
  });
  it("rejects equal version with different payload rather than treating it as duplicate", async () => {
    const one = event();
    const client = {
      request: async (method) => {
        if (method === "PUT") {
          const error = new Error();
          error.status = 409;
          throw error;
        }
        return { _version: 2, _source: { ...one.data.snapshot, active: true } };
      },
    };
    await expect(createPropertyIndex({ client }).apply(one)).rejects.toThrow(
      "SEARCH_VERSION_PAYLOAD_CONFLICT",
    );
  });
  it("does not overwrite a newer tombstone with an older event", async () => {
    const one = event();
    const client = {
      request: vi.fn(async (method) => {
        if (method === "PUT") {
          const error = new Error();
          error.status = 409;
          throw error;
        }
        return { _version: 3, _source: { ...one.data.snapshot, version: 3 } };
      }),
    };
    expect(await createPropertyIndex({ client }).apply(one)).toEqual({
      updated: false,
    });
    expect(
      client.request.mock.calls.filter(([method]) => method === "PUT"),
    ).toHaveLength(1);
  });
});
