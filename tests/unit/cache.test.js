const {
  createPublicCache,
  createSourceGate,
  hashQuery,
} = require("../../src/infrastructure/redis/cache");
const {
  normalizeDiscoveryQuery,
  isPublicCatalog,
} = require("../../src/modules/properties/public-catalog");

describe("public cache invariants", () => {
  it("canonicalizes equivalent queries without dates, tokens or user IDs", () => {
    const a = normalizeDiscoveryQuery({
      q: "  HÀ   NỘI  ",
      amenity: ["wifi", "pool", "wifi"],
      minPrice: "100",
      checkIn: "2026-12-01",
      roomQuantity: 3,
      userId: "secret",
    });
    const b = normalizeDiscoveryQuery({
      q: "hà nội",
      amenity: ["pool", "wifi"],
      minPrice: 100,
      checkIn: "2027-01-01",
      roomQuantity: 1,
    });
    expect(hashQuery(a)).toBe(hashQuery(b));
    expect(hashQuery(a)).not.toBe(hashQuery({ ...a, page: 2 }));
    expect(hashQuery(a)).not.toBe(hashQuery({ ...a, minPrice: 101 }));
    expect(a).not.toHaveProperty("userId");
    expect(isPublicCatalog([{ email: "private" }])).toBe(false);
  });

  it("single-flights 100 concurrent misses with Redis down and never leaks mutable responses", async () => {
    const cache = createPublicCache({
      redis: {
        execute: async () => {
          throw new Error("down");
        },
      },
      namespace: "test",
    });
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ name: "public" }];
    });
    const options = {
      kind: "search",
      scope: "pg",
      ttlSeconds: 30,
      load,
      validate: Array.isArray,
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.read(options)),
    );
    expect(load).toHaveBeenCalledTimes(1);
    results[0][0].name = "private";
    expect(results[1][0].name).toBe("public");
  });

  it("propagates source failure, including 404, rather than negative caching", async () => {
    const cache = createPublicCache({ enabled: false, namespace: "test" });
    const load = vi.fn().mockRejectedValue(new Error("source failed"));
    const options = {
      kind: "property",
      scope: "p",
      ttlSeconds: 30,
      load,
      validate: Array.isArray,
    };
    await expect(cache.read(options)).rejects.toThrow("source failed");
    await expect(cache.read(options)).rejects.toThrow("source failed");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds the source queue and times out without starting expired work", async () => {
    const gate = createSourceGate({
      concurrency: 1,
      maxQueue: 1,
      deadlineMs: 30,
    });
    let release;
    const active = gate(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const queuedLoad = vi.fn();
    const queued = gate(queuedLoad);
    await expect(gate(() => {})).rejects.toMatchObject({
      code: "CATALOG_BUSY",
    });
    await Promise.all([
      expect(active).rejects.toMatchObject({ code: "CATALOG_TIMEOUT" }),
      expect(queued).rejects.toMatchObject({ code: "CATALOG_TIMEOUT" }),
    ]);
    release();
    expect(queuedLoad).not.toHaveBeenCalled();
  });
});
