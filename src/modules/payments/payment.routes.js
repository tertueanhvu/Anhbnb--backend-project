const express = require("express");
const { asyncHandler } = require("../../shared/http/async-handler");
const { validate } = require("../../middlewares/validate");
const validator = require("./payment.validator");
const { createWebhookCapacity } = require("../../middlewares/webhook-capacity");

function createPaymentRouter({
  controller,
  authenticate,
  limiters,
  webhookMaxConcurrent,
}) {
  const router = express.Router();
  router.post(
    "/bookings/:bookingId/payments",
    authenticate,
    limiters.payment,
    validate(validator.bookingPayment),
    asyncHandler(controller.create),
  );
  router.post(
    "/payments/zalopay/callback",
    createWebhookCapacity(webhookMaxConcurrent),
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
    limiters.payment,
    validate(validator.paymentParams),
    asyncHandler(controller.reconcile),
  );
  return router;
}

module.exports = { createPaymentRouter };
