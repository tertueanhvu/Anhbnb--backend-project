const { asVndInteger, sumVnd } = require("../../src/shared/money");

describe("VND money utilities", () => {
  it("adds integer amounts without floating point arithmetic", () => {
    expect(sumVnd(["650000", 850000])).toBe(1500000);
  });

  it("rejects fractional and unsafe amounts", () => {
    expect(() => asVndInteger(10.5)).toThrow();
    expect(() => asVndInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
