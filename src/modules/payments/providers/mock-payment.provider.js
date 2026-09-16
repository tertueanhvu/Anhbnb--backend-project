function createMockPaymentProvider({ key2 = "mock-callback-key" } = {}) {
  return {
    name: "ZALOPAY",
    appId: "MOCK",
    async createOrder(payment) {
      return {
        checkoutUrl: `https://mock-payments.local/checkout/${payment.appTransId}`,
        providerCode: "1",
        providerMessage: "mock order created",
      };
    },
    verifyCallback(body) {
      const { verifyCallbackMac } = require("./zalopay.provider");
      if (!verifyCallbackMac(body.data, body.mac, key2)) {
        const { AppError } = require("../../../shared/errors/app-error");
        throw new AppError(
          401,
          "INVALID_CALLBACK_MAC",
          "Callback MAC không hợp lệ.",
        );
      }
      return JSON.parse(body.data);
    },
    async queryOrder(appTransId) {
      return { status: "PENDING", appTransId };
    },
  };
}

module.exports = { createMockPaymentProvider };
