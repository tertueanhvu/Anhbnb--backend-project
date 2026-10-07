const express = require("express");
const Joi = require("joi");
const { validate } = require("../../middlewares/validate");
const { asyncHandler } = require("../../shared/http/async-handler");
function createReferenceRouter({ service, authenticate, limiters }) {
  const router = express.Router();
  const schema = {
    query: Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
    }).unknown(false),
  };
  for (const kind of ["amenities", "locations"]) {
    router.get(
      `/${kind}`,
      (req, res, next) =>
        req.get("Authorization") ? authenticate(req, res, next) : next(),
      limiters.search,
      validate(schema),
      asyncHandler(async (req, res) =>
        res.json(await service.list(kind, req.query)),
      ),
    );
  }
  return router;
}
module.exports = { createReferenceRouter };
