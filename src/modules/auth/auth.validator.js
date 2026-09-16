const Joi = require("joi");

const email = Joi.string().email().max(254).required();
const password = Joi.string()
  .min(8)
  .max(72)
  .pattern(/[a-z]/)
  .pattern(/[A-Z]/)
  .pattern(/[0-9]/)
  .required()
  .messages({
    "string.pattern.base":
      "password must contain uppercase, lowercase and number",
  });
const fullName = Joi.string().trim().min(2).max(120);
const phone = Joi.string()
  .trim()
  .pattern(/^\+?[0-9][0-9 .-]{7,19}$/)
  .allow("", null);

const register = {
  body: Joi.object({
    email,
    password,
    fullName: fullName.required(),
    phone,
  }).unknown(false),
};

const login = {
  body: Joi.object({
    email,
    password: Joi.string().max(200).required(),
  }).unknown(false),
};

const updateProfile = {
  body: Joi.object({ fullName, phone }).or("fullName", "phone").unknown(false),
};

module.exports = { login, register, updateProfile };
