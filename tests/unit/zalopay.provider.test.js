const {
  hmacSha256,
  verifyCallbackMac,
} = require("../../src/modules/payments/providers/zalopay.provider");

describe("ZaloPay HMAC", () => {
  it("accepts only an exact SHA-256 callback MAC", () => {
    const data = JSON.stringify({ app_trans_id: "260914_test", amount: 1000 });
    const key = "non-sensitive-test-key";
    const mac = hmacSha256(key, data);
    expect(verifyCallbackMac(data, mac, key)).toBe(true);
    expect(verifyCallbackMac(`${data}x`, mac, key)).toBe(false);
    expect(verifyCallbackMac(data, `${mac.slice(0, -1)}0`, key)).toBe(false);
  });
});
