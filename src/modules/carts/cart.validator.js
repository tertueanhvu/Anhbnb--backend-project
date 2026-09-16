const Joi = require("joi");
const { date, uuid } = require("../availability/availability.validator");

const selection = {
  roomTypeId: uuid.required(),
  checkIn: date.required(),
  checkOut: date.required(),
  roomQuantity: Joi.number().integer().min(1).required(),
  adults: Joi.number().integer().min(1).required(),
  children: Joi.number().integer().min(0).default(0),
};

const itemParams = {
  params: Joi.object({ cartItemId: uuid.required() }).unknown(false),
};
const add = { body: Joi.object(selection).unknown(false) };
const update = {
  ...itemParams,
  body: Joi.object({
    checkIn: date,
    checkOut: date,
    roomQuantity: Joi.number().integer().min(1),
    adults: Joi.number().integer().min(1),
    children: Joi.number().integer().min(0),
  })
    .min(1)
    .unknown(false),
};

module.exports = { add, itemParams, update };
