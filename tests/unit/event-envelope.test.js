const {
  createEnvelope,
  validateEnvelope,
} = require("../../src/modules/events/event-envelope");
const {
  createOutboxRepository,
} = require("../../src/modules/events/outbox.repository");
const { eventContext } = require("../../src/modules/events/event-context");
const { randomUUID } = require("node:crypto");

describe("transactional event contract", () => {
  const input = () => ({
    aggregateType: "booking",
    aggregateId: randomUUID(),
    version: 1,
    eventType: "BookingHeld",
    requestId: "same-request",
    data: { status: "PENDING_PAYMENT" },
  });
  it("creates distinct event IDs for the same request and preserves event identity when validated/replayed", () => {
    const a = createEnvelope(input()),
      b = createEnvelope(input());
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.request_id).toBe(b.request_id);
    expect(validateEnvelope(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(() => validateEnvelope({ ...a, aggregate_version: 0 })).toThrow(
      "INVALID_EVENT_ENVELOPE",
    );
  });
  it("refuses non-transactional publish and rolls insert failure back to its caller", async () => {
    const outbox = createOutboxRepository();
    await expect(outbox.append(() => {}, input())).rejects.toThrow(
      "OUTBOX_REQUIRES_BUSINESS_TRANSACTION",
    );
    const trx = () => ({
      insert: async () => {
        throw new Error("outbox insert failed");
      },
    });
    trx.isTransaction = true;
    await expect(outbox.append(trx, input())).rejects.toThrow(
      "outbox insert failed",
    );
  });
  it("propagates correlation context without using request_id as the event ID", async () => {
    const inserts = [];
    const trx = () => ({ insert: async (row) => inserts.push(row) });
    trx.isTransaction = true;
    const outbox = createOutboxRepository();
    await eventContext.run({ requestId: "http-request" }, () =>
      outbox.append(trx, { ...input(), requestId: undefined }),
    );
    expect(inserts[0].request_id).toBe("http-request");
    expect(inserts[0].event_id).not.toBe("http-request");
  });
});
