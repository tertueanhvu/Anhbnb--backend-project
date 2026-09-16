const express = require("express");
const { asyncHandler } = require("../../shared/http/async-handler");
const { validate } = require("../../middlewares/validate");
const validator = require("./cart.validator");

function createCartRouter({ controller, authenticate }) {
  const router = express.Router();
  router.use("/cart", authenticate);
  router.get("/cart", asyncHandler(controller.get));
  router.post(
    "/cart/items",
    validate(validator.add),
    asyncHandler(controller.add),
  );
  router.patch(
    "/cart/items/:cartItemId",
    validate(validator.update),
    asyncHandler(controller.update),
  );
  router.delete(
    "/cart/items/:cartItemId",
    validate(validator.itemParams),
    asyncHandler(controller.remove),
  );
  router.delete("/cart/items", asyncHandler(controller.clear));
  return router;
}

module.exports = { createCartRouter };
