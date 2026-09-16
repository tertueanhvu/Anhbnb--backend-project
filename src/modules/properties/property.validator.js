const Joi = require("joi");
const { date, uuid } = require("../availability/availability.validator");

const stayFields = {
  checkIn: date,
  checkOut: date,
  roomQuantity: Joi.number().integer().min(1).default(1),
  adults: Joi.number().integer().min(1).default(1),
  children: Joi.number().integer().min(0).default(0),
};

const filters = {
  city: Joi.string().trim().max(100),
  district: Joi.string().trim().max(100),
  q: Joi.string().trim().max(200),
  amenity: Joi.alternatives().try(
    Joi.string().max(50),
    Joi.array().items(Joi.string().max(50)).max(20),
  ),
  minPrice: Joi.number().integer().min(0),
  maxPrice: Joi.number().integer().min(0),
  minBedrooms: Joi.number().integer().min(0),
  minBathrooms: Joi.number().min(0),
  sort: Joi.string()
    .valid("recommended", "price_asc", "price_desc", "name_asc")
    .default("recommended"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

const list = {
  query: Joi.object({ ...stayFields, ...filters })
    .and("checkIn", "checkOut")
    .custom((value, helpers) => {
      if (
        value.minPrice !== undefined &&
        value.maxPrice !== undefined &&
        value.minPrice > value.maxPrice
      ) {
        return helpers.error("any.invalid");
      }
      return value;
    })
    .unknown(false),
};

const detail = {
  params: Joi.object({ propertyId: uuid.required() }).unknown(false),
  query: Joi.object(stayFields).and("checkIn", "checkOut").unknown(false),
};

module.exports = { detail, list };
