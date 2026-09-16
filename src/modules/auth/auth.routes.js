const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { validate } = require("../../middlewares/validate");
const { asyncHandler } = require("../../shared/http/async-handler");
const validator = require("./auth.validator");

function createAuthRouter({ controller, authenticate }) {
  const router = express.Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  router.post(
    "/auth/register",
    authLimiter,
    validate(validator.register),
    asyncHandler(controller.register),
  );
  router.post(
    "/auth/login",
    authLimiter,
    validate(validator.login),
    asyncHandler(controller.login),
  );
  router.get("/users/me", authenticate, asyncHandler(controller.me));
  router.patch(
    "/users/me",
    authenticate,
    validate(validator.updateProfile),
    asyncHandler(controller.updateMe),
  );
  return router;
}

module.exports = { createAuthRouter };
