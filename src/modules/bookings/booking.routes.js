const express = require("express");
const { asyncHandler } = require("../../shared/http/async-handler");
const { validate } = require("../../middlewares/validate");
const validator = require("./booking.validator");

function createBookingRouter({ controller, authenticate }) {
  const router = express.Router();
  router.use("/bookings", authenticate);
  router.post(
    "/bookings",
    validate(validator.create),
    asyncHandler(controller.create),
  );
  router.get(
    "/bookings",
    validate(validator.list),
    asyncHandler(controller.list),
  );
  router.get(
    "/bookings/:bookingId",
    validate(validator.bookingParams),
    asyncHandler(controller.detail),
  );
  router.post(
    "/bookings/:bookingId/cancellations",
    validate(validator.cancel),
    asyncHandler(controller.cancel),
  );
  return router;
}

module.exports = { createBookingRouter };
