const { sendData } = require("../../shared/http/respond");

function createPropertyController(service) {
  return {
    async list(req, res) {
      const result = await service.list(req.query);
      return sendData(res, result.data, 200, result.meta);
    },
    async detail(req, res) {
      return sendData(
        res,
        await service.detail(req.params.propertyId, req.query),
      );
    },
  };
}

module.exports = { createPropertyController };
