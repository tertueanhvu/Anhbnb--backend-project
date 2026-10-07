const { randomUUID } = require("node:crypto");
const { createEnvelope } = require("../../src/modules/events/event-envelope");
const {
  createBatchHandler,
  decodeEvent,
} = require("../../src/infrastructure/kafka/consumer");
const { createDeadLetterSink } = require("../../src/infrastructure/kafka/dlq");

function fixture() {
  const events = [1, 2].map((version) =>
    createEnvelope({
      aggregateType: "booking",
      aggregateId: randomUUID(),
      version,
      eventType: "BookingHeld",
      requestId: "shared-request",
      data: {},
    }),
  );
  const messages = events.map((event, index) => ({
    key: Buffer.from(event.aggregate_id),
    value: Buffer.from(JSON.stringify(event)),
    offset: String(index + 10),
  }));
  const consumer = { commitOffsets: vi.fn().mockResolvedValue(undefined) };
  const handler = {
    name: "notification-v1",
    topics: ["booking"],
    handle: vi.fn().mockResolvedValue(undefined),
  };
  const deadLetter = vi.fn().mockResolvedValue(undefined);
  const input = {
    batch: { topic: "unit.booking.events.v1", partition: 1, messages },
    resolveOffset: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    isRunning: () => true,
    isStale: () => false,
  };
  return { events, messages, consumer, handler, deadLetter, input };
}
describe("manual consumer offset boundaries", () => {
  it("commits only after each effect and does not dedup different events sharing a request", async () => {
    const f = fixture(),
      order = [];
    f.handler.handle.mockImplementation(async (event) => {
      order.push(event.event_id);
    });
    f.consumer.commitOffsets.mockImplementation(async ([offset]) => {
      order.push(offset.offset);
    });
    await createBatchHandler(f)(f.input);
    expect(order).toEqual([
      f.events[0].event_id,
      "11",
      f.events[1].event_id,
      "12",
    ]);
  });
  it("does not pass an in-flight message", async () => {
    const f = fixture();
    let release;
    f.handler.handle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = createBatchHandler(f)(f.input);
    await Promise.resolve();
    expect(f.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(f.handler.handle).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(f.consumer.commitOffsets).toHaveBeenCalledTimes(2);
  });
  it("DLQ failure leaves offset and later records untouched", async () => {
    const f = fixture();
    f.handler.handle.mockRejectedValue(new Error("DB unavailable"));
    f.deadLetter.mockRejectedValue(new Error("broker unavailable"));
    await expect(
      createBatchHandler({ ...f, retryMax: 1, wait: async () => {} })(f.input),
    ).rejects.toThrow("broker unavailable");
    expect(f.handler.handle).toHaveBeenCalledTimes(2);
    expect(f.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(f.input.resolveOffset).not.toHaveBeenCalled();
  });
  it("acknowledges DLQ handoff before committing poison offset", async () => {
    const f = fixture(),
      order = [];
    f.handler.handle.mockRejectedValueOnce(new Error("bad data"));
    f.deadLetter.mockImplementation(async () => {
      order.push("DLQ acknowledged");
    });
    f.consumer.commitOffsets.mockImplementation(async ([offset]) => {
      order.push(offset.offset);
    });
    await createBatchHandler({ ...f, retryMax: 0 })(f.input);
    expect(order).toEqual(["DLQ acknowledged", "11", "12"]);
  });
  it("a stale batch after effect is redelivered without offset commit", async () => {
    const f = fixture();
    let stale = false;
    f.input.isStale = () => stale;
    f.handler.handle.mockImplementation(async () => {
      stale = true;
    });
    await createBatchHandler(f)(f.input);
    expect(f.consumer.commitOffsets).not.toHaveBeenCalled();
  });
  it("rejects wrong keys, malformed payloads and null records", () => {
    const f = fixture();
    expect(() =>
      decodeEvent({ ...f.messages[0], key: Buffer.from("wrong") }),
    ).toThrow("EVENT_KEY_MISMATCH");
    expect(() => decodeEvent({ value: null })).toThrow();
    expect(() => decodeEvent({ value: Buffer.from("{}") })).toThrow();
  });
  it("DLQ is durable in Kafka before the DB ledger; arbitrary error text is excluded", async () => {
    const f = fixture(),
      calls = [];
    const producer = {
      send: vi.fn(async () => {
        calls.push("kafka");
      }),
    };
    const db = () => ({
      insert: (row) => {
        calls.push("db");
        expect(row.error_code).toBe("CONSUMER_EFFECT_FAILED");
        return { onConflict: () => ({ ignore: async () => {} }) };
      },
    });
    await createDeadLetterSink({ db, producer })({
      consumerName: f.handler.name,
      event: f.events[0],
      record: {
        topic: f.input.batch.topic,
        partition: 1,
        message: f.messages[0],
      },
      error: new Error("SECRET_PASSWORD"),
      attempts: 6,
    });
    expect(calls).toEqual(["kafka", "db"]);
    expect(producer.send.mock.calls[0][0].acks).toBe(-1);
    expect(JSON.stringify(producer.send.mock.calls)).not.toContain(
      "SECRET_PASSWORD",
    );
  });
});
