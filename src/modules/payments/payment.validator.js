const Joi = require("joi");
const { uuid } = require("../availability/availability.validator");

const bookingPayment = {
  params: Joi.object({ bookingId: uuid.required() }).unknown(false),
  body: Joi.object({
    provider: Joi.string().valid("ZALOPAY").required(),
  }).unknown(false),
};
const paymentParams = {
  params: Joi.object({ paymentId: uuid.required() }).unknown(false),
};
const callback = {
  body: Joi.object({
    data: Joi.string().required(),
    mac: Joi.string().hex().required(),
    type: Joi.number().integer(),
  }).unknown(false),
};

module.exports = { bookingPayment, callback, paymentParams };
