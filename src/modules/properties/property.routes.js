const express = require("express");
const { asyncHandler } = require("../../shared/http/async-handler");
const { validate } = require("../../middlewares/validate");
const validator = require("./property.validator");
const availabilityValidator = require("../availability/availability.validator");

function createPropertyRouter({ controller, availabilityController }) {
  const router = express.Router();
  router.get(
    "/properties",
    validate(validator.list),
    asyncHandler(controller.list),
  );
  router.get(
    "/properties/:propertyId",
    validate(validator.detail),
    asyncHandler(controller.detail),
  );
  router.get(
    "/properties/:propertyId/room-types/:roomTypeId/availability",
    validate(availabilityValidator.availability),
    asyncHandler(availabilityController.get),
  );
  return router;
}

module.exports = { createPropertyRouter };
