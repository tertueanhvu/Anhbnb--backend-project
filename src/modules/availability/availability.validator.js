const Joi = require("joi");

const uuid = Joi.string().guid({ version: ["uuidv4"] });
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

const availability = {
  params: Joi.object({
    propertyId: uuid.required(),
    roomTypeId: uuid.required(),
  }).unknown(false),
  query: Joi.object({
    checkIn: date.required(),
    checkOut: date.required(),
    roomQuantity: Joi.number().integer().min(1).default(1),
    adults: Joi.number().integer().min(1).required(),
    children: Joi.number().integer().min(0).default(0),
  }).unknown(false),
};

module.exports = { availability, date, uuid };
