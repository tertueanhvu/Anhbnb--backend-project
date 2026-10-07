const Joi = require("joi");
const { paginationMeta, parsePagination } = require("../../shared/pagination");
const schemas = {
  amenities: Joi.array().items(
    Joi.object({
      id: Joi.string().uuid().required(),
      code: Joi.string().required(),
      name: Joi.string().required(),
      icon: Joi.string().allow(null, ""),
    }).unknown(false),
  ),
  locations: Joi.array().items(
    Joi.object({
      city: Joi.string().required(),
      district: Joi.string().allow(null, ""),
      country_code: Joi.string().required(),
    }).unknown(false),
  ),
};
function createReferenceService({ repository, cache, ttlSeconds = 3600 }) {
  return {
    async list(kind, query) {
      const { page, limit, offset } = parsePagination(query);
      const rows = await cache.read({
        kind: "reference",
        scope: kind,
        query: { page, limit, locale: "vi-VN" },
        ttlSeconds,
        load: () => repository[kind](),
        validate: (value) =>
          !schemas[kind].validate(value, { convert: false }).error,
      });
      return {
        data: rows.slice(offset, offset + limit),
        meta: paginationMeta(page, limit, rows.length),
      };
    },
  };
}
module.exports = { createReferenceService };
