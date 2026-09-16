const { sendData } = require("../../shared/http/respond");

function createPaymentController(service) {
  return {
    async create(req, res) {
      const result = await service.create(req.auth.id, req.params.bookingId);
      return sendData(res, result.payment, result.reused ? 200 : 201);
    },
    async callback(req, res) {
      try {
        const result = await service.callback(req.body);
        return res.json({
          return_code: 1,
          return_message: result.manualRefundRequired
            ? "success_manual_refund_required"
            : "success",
        });
      } catch (error) {
        req.log?.warn(
          { code: error.code, requestId: req.id },
          "Rejected payment callback",
        );
        return res.json({
          return_code: 2,
          return_message: error.code || "callback_failed",
        });
      }
    },
    async get(req, res) {
      return sendData(
        res,
        await service.get(req.auth.id, req.params.paymentId),
      );
    },
    async reconcile(req, res) {
      return sendData(
        res,
        await service.reconcile(req.auth.id, req.params.paymentId),
      );
    },
  };
}

module.exports = { createPaymentController };
