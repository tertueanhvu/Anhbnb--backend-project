const { sendData } = require("../../shared/http/respond");

function createBookingController(service) {
  return {
    async create(req, res) {
      const result = await service.create(
        req.auth.id,
        req.get("Idempotency-Key"),
        req.body,
      );
      return sendData(res, result.booking, result.reused ? 200 : 201);
    },
    async list(req, res) {
      const result = await service.list(req.auth.id, req.query);
      return sendData(res, result.data, 200, result.meta);
    },
    async detail(req, res) {
      return sendData(
        res,
        await service.detail(req.auth.id, req.params.bookingId),
      );
    },
    async cancel(req, res) {
      return sendData(
        res,
        await service.cancel(
          req.auth.id,
          req.params.bookingId,
          req.body.reason,
        ),
      );
    },
  };
}

module.exports = { createBookingController };
