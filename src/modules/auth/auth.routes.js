const express = require("express");
const { validate } = require("../../middlewares/validate");
const { asyncHandler } = require("../../shared/http/async-handler");
const validator = require("./auth.validator");

function createAuthRouter({ controller, authenticate, limiters }) {
  const router = express.Router();

  router.post(
    "/auth/register",
    limiters.register,
    validate(validator.register),
    asyncHandler(controller.register),
  );
  router.post(
    "/auth/login",
    limiters.login,
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
