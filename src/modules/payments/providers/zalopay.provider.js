const { createHmac } = require("node:crypto");
const axios = require("axios");
const { AppError } = require("../../../shared/errors/app-error");

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest("hex");
}

function verifyCallbackMac(data, mac, key2) {
  if (!data || !mac || !key2) return false;
  const expected = hmacSha256(key2, data);
  if (expected.length !== mac.length) return false;
  return require("node:crypto").timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(mac),
  );
}

function createZaloPayProvider(config, http = axios) {
  return {
    name: "ZALOPAY",
    appId: String(config.appId),

    async createOrder(payment) {
      const embedData = JSON.stringify({
        callback_url: config.callbackUrl,
        booking_id: payment.bookingId,
      });
      const item = JSON.stringify([]);
      const appUser = payment.userId;
      const appTime = Date.now();
      const data = [
        config.appId,
        payment.appTransId,
        appUser,
        payment.amount,
        appTime,
        embedData,
        item,
      ].join("|");
      const payload = new URLSearchParams({
        app_id: String(config.appId),
        app_trans_id: payment.appTransId,
        app_user: appUser,
        app_time: String(appTime),
        amount: String(payment.amount),
        item,
        embed_data: embedData,
        description: `Thanh toan booking ${payment.bookingCode}`,
        bank_code: "",
        callback_url: config.callbackUrl,
        mac: hmacSha256(config.key1, data),
      });
      let response;
      try {
        response = await http.post(config.createOrderUrl, payload, {
          timeout: 8000,
        });
      } catch (cause) {
        const error = new AppError(
          502,
          "PAYMENT_PROVIDER_ERROR",
          "Không kết nối được ZaloPay.",
        );
        error.cause = cause;
        error.definitive = false;
        throw error;
      }
      if (
        Number(response.data?.return_code) !== 1 ||
        !response.data?.order_url
      ) {
        const error = new AppError(
          502,
          "PAYMENT_PROVIDER_ERROR",
          "ZaloPay từ chối tạo đơn thanh toán.",
        );
        error.definitive = true;
        error.providerCode = String(
          response.data?.sub_return_code ??
            response.data?.return_code ??
            "UNKNOWN",
        );
        throw error;
      }
      return {
        checkoutUrl: response.data.order_url,
        providerCode: String(response.data.return_code),
        providerMessage: String(
          response.data.return_message || "success",
        ).slice(0, 500),
      };
    },

    verifyCallback(body) {
      if (!verifyCallbackMac(body.data, body.mac, config.key2)) {
        throw new AppError(
          401,
          "INVALID_CALLBACK_MAC",
          "Callback MAC không hợp lệ.",
        );
      }
      let data;
      try {
        data = JSON.parse(body.data);
      } catch {
        throw new AppError(
          422,
          "INVALID_CALLBACK_DATA",
          "Callback data không phải JSON hợp lệ.",
        );
      }
      return data;
    },

    async queryOrder(appTransId) {
      const data = `${config.appId}|${appTransId}|${config.key1}`;
      const payload = new URLSearchParams({
        app_id: String(config.appId),
        app_trans_id: appTransId,
        mac: hmacSha256(config.key1, data),
      });
      let response;
      try {
        response = await http.post(config.queryOrderUrl, payload, {
          timeout: 8000,
        });
      } catch (cause) {
        const error = new AppError(
          502,
          "PAYMENT_PROVIDER_ERROR",
          "Không đối soát được ZaloPay.",
        );
        error.cause = cause;
        throw error;
      }
      const code = Number(response.data?.return_code);
      if (code === 1) {
        return {
          status: "SUCCEEDED",
          appId: String(config.appId),
          appTransId,
          amount: Number(response.data.amount),
          providerTransId: String(response.data.zp_trans_id),
          paidAt: response.data.server_time
            ? new Date(Number(response.data.server_time))
            : new Date(),
        };
      }
      if (code === 2 || code === 3) return { status: "PENDING", appTransId };
      return { status: "FAILED", appTransId, providerCode: String(code) };
    },
  };
}

module.exports = { createZaloPayProvider, hmacSha256, verifyCallbackMac };
