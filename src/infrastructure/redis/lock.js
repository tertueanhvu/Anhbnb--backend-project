const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { AppError } = require("../../shared/errors/app-error");

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1]) else return 0 end`;

function createBookingLock({
  redis,
  namespace,
  ttlMs = 10000,
  retryCount = 3,
  waitMs = 500,
  metrics,
  sleep = delay,
}) {
  return {
    async acquire(roomTypeId) {
      const key = `${namespace}:lock:booking:room-type:${roomTypeId}`;
      const token = randomUUID();
      const started = Date.now();
      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        let acquired;
        try {
          acquired = await redis.execute((client) =>
            client.set(key, token, "NX", "EX", Math.ceil(ttlMs / 1000)),
          );
        } catch {
          metrics?.increment("booking_lock.fallback_db");
          return async () => {};
        }
        if (acquired) {
          metrics?.increment("booking_lock.acquired");
          return async () => {
            try {
              const released = await redis.execute((client) =>
                client.eval(RELEASE, 1, key, token),
              );
              if (!released) metrics?.increment("booking_lock.lease_lost");
            } catch {
              // A release failure must never replay a committed booking.
              metrics?.increment("booking_lock.release_error");
            }
          };
        }
        const remaining = waitMs - (Date.now() - started);
        if (attempt === retryCount || remaining <= 0) break;
        await sleep(Math.min(remaining, 50 + Math.floor(Math.random() * 101)));
      }
      metrics?.increment("booking_lock.busy");
      const error = new AppError(
        409,
        "BOOKING_IN_PROGRESS",
        "Phòng đang được xử lý, hãy thử lại với cùng Idempotency-Key.",
      );
      error.retryAfter = 1;
      throw error;
    },
  };
}

module.exports = { createBookingLock, RELEASE };
