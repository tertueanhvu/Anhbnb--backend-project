const Joi = require("joi");
const { randomUUID } = require("node:crypto");

const schema = Joi.object({
  schema_version: Joi.number().valid(1).required(),
  event_id: Joi.string().uuid().required(),
  event_type: Joi.string()
    .pattern(/^[A-Z][A-Za-z]+$/)
    .required(),
  aggregate_type: Joi.string()
    .valid("booking", "payment", "catalog")
    .required(),
  aggregate_id: Joi.string().uuid().required(),
  aggregate_version: Joi.number()
    .integer()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .required(),
  request_id: Joi.string().max(200).allow(null).required(),
  occurred_at: Joi.string().isoDate().required(),
  data: Joi.object().required(),
}).unknown(false);

function createEnvelope({
  aggregateType,
  aggregateId,
  version,
  eventType,
  data,
  requestId = null,
}) {
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    aggregate_version: Number(version),
    request_id: requestId,
    occurred_at: new Date().toISOString(),
    data,
  };
  return validateEnvelope(event);
}
function validateEnvelope(event) {
  const { value, error } = schema.validate(event, { convert: false });
  if (error) throw new Error("INVALID_EVENT_ENVELOPE");
  return value;
}
module.exports = { createEnvelope, validateEnvelope };
