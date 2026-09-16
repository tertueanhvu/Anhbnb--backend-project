const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { asyncHandler } = require("../../shared/http/async-handler");
const { validate } = require("../../middlewares/validate");
const validator = require("./payment.validator");

function createPaymentRouter({ controller, authenticate }) {
  const router = express.Router();
  const paymentLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  router.post(
    "/bookings/:bookingId/payments",
    authenticate,
    paymentLimiter,
    validate(validator.bookingPayment),
    asyncHandler(controller.create),
  );
  router.post(
    "/payments/zalopay/callback",
    paymentLimiter,
    validate(validator.callback),
    asyncHandler(controller.callback),
  );
  router.get(
    "/payments/:paymentId",
    authenticate,
    validate(validator.paymentParams),
    asyncHandler(controller.get),
  );
  router.post(
    "/payments/:paymentId/reconcile",
    authenticate,
    paymentLimiter,
    validate(validator.paymentParams),
    asyncHandler(controller.reconcile),
  );
  return router;
}

module.exports = { createPaymentRouter };
