const {
  canonicalize,
  fingerprint,
} = require("../../src/modules/bookings/booking.service");

describe("booking idempotency fingerprint", () => {
  it("is stable across object key order but changes with payload data", () => {
    expect(canonicalize({ z: 1, a: { y: 2, x: 3 } })).toEqual({
      a: { x: 3, y: 2 },
      z: 1,
    });
    expect(
      fingerprint({
        roomQuantity: 1,
        contact: { email: "a@example.com", phone: "1" },
      }),
    ).toBe(
      fingerprint({
        contact: { phone: "1", email: "a@example.com" },
        roomQuantity: 1,
      }),
    );
    expect(fingerprint({ roomQuantity: 1 })).not.toBe(
      fingerprint({ roomQuantity: 2 }),
    );
  });
});
