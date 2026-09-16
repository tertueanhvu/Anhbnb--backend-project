const Joi = require("joi");
const { date, uuid } = require("../availability/availability.validator");

const contact = Joi.object({
  fullName: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().email().max(254).required(),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9][0-9 .-]{7,19}$/)
    .required(),
}).unknown(false);

const directFields = {
  roomTypeId: uuid.required(),
  checkIn: date.required(),
  checkOut: date.required(),
  roomQuantity: Joi.number().integer().min(1).required(),
  adults: Joi.number().integer().min(1).required(),
  children: Joi.number().integer().min(0).default(0),
};

const create = {
  body: Joi.alternatives()
    .try(
      Joi.object({
        ...directFields,
        contact: contact.required(),
        specialRequests: Joi.string().trim().max(1000).allow(""),
      }).unknown(false),
      Joi.object({
        cartItemId: uuid.required(),
        contact: contact.required(),
        specialRequests: Joi.string().trim().max(1000).allow(""),
      }).unknown(false),
    )
    .match("one"),
};

const bookingParams = {
  params: Joi.object({ bookingId: uuid.required() }).unknown(false),
};
const list = {
  query: Joi.object({
    status: Joi.string().valid(
      "PENDING_PAYMENT",
      "CONFIRMED",
      "CANCELLED",
      "EXPIRED",
      "COMPLETED",
    ),
    from: date,
    to: date,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }).unknown(false),
};
const cancel = {
  ...bookingParams,
  body: Joi.object({ reason: Joi.string().trim().max(500).allow("") }).unknown(
    false,
  ),
};

module.exports = { bookingParams, cancel, create, list };
