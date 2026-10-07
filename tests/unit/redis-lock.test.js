const {
  createBookingLock,
  RELEASE,
} = require("../../src/infrastructure/redis/lock");
const { transactionWithRetry } = require("../../src/db/transaction-retry");

describe("booking lease", () => {
  it("uses a unique owner, EX TTL, and token-checked release", async () => {
    const client = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    };
    const redis = { execute: (fn) => fn(client) };
    const lock = createBookingLock({ redis, namespace: "test" });
    const release = await lock.acquire("room");
    const [key, token, nx, ex, ttl] = client.set.mock.calls[0];
    expect([key, nx, ex, ttl]).toEqual([
      "test:lock:booking:room-type:room",
      "NX",
      "EX",
      10,
    ]);
    await release();
    expect(client.eval).toHaveBeenCalledWith(RELEASE, 1, key, token);
    await lock.acquire("room");
    expect(client.set.mock.calls[1][1]).not.toBe(token);
  });

  it("has bounded contention retries and does not turn a busy lease into DB fallback", async () => {
    const client = { set: vi.fn().mockResolvedValue(null) };
    const lock = createBookingLock({
      redis: { execute: (fn) => fn(client) },
      namespace: "test",
      sleep: async () => {},
    });
    await expect(lock.acquire("room")).rejects.toMatchObject({
      status: 409,
      code: "BOOKING_IN_PROGRESS",
      retryAfter: 1,
    });
    expect(client.set).toHaveBeenCalledTimes(4);
  });

  it("falls back to DB on unavailable Redis and swallows post-commit release failure", async () => {
    const redis = { execute: vi.fn().mockRejectedValue(new Error("down")) };
    await (
      await createBookingLock({ redis, namespace: "test" }).acquire("room")
    )();
    redis.execute.mockResolvedValueOnce("OK");
    const release = await createBookingLock({
      redis,
      namespace: "test",
    }).acquire("room");
    await expect(release()).resolves.toBeUndefined();
  });
});

describe("whole transaction retry", () => {
  it("retries PostgreSQL rollback codes only, and bounds attempts", async () => {
    const operation = vi.fn();
    const db = {
      transaction: vi
        .fn()
        .mockRejectedValueOnce({ code: "40P01" })
        .mockResolvedValue(123),
    };
    expect(
      await transactionWithRetry(db, operation, { sleep: async () => {} }),
    ).toBe(123);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    db.transaction.mockReset().mockRejectedValue({ code: "ECONNRESET" });
    await expect(transactionWithRetry(db, operation)).rejects.toEqual({
      code: "ECONNRESET",
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    db.transaction.mockReset().mockRejectedValue({ code: "40001" });
    await expect(
      transactionWithRetry(db, operation, { sleep: async () => {} }),
    ).rejects.toEqual({ code: "40001" });
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });
});
