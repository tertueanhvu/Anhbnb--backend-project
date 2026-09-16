const { sendData } = require("../../shared/http/respond");

function createAvailabilityController(service) {
  return {
    async get(req, res) {
      return sendData(
        res,
        await service.getAvailability({
          ...req.query,
          propertyId: req.params.propertyId,
          roomTypeId: req.params.roomTypeId,
        }),
      );
    },
  };
}

module.exports = { createAvailabilityController };
