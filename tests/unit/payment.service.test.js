const { appTransId } = require("../../src/modules/payments/payment.service");

describe("payment identifiers", () => {
  it("uses the Vietnam calendar date required by ZaloPay", () => {
    const now = new Date("2026-09-14T17:30:00.000Z");
    expect(appTransId(now, "BKTEST", 1, "Asia/Ho_Chi_Minh")).toBe(
      "260915_BKTEST_1",
    );
  });
});
