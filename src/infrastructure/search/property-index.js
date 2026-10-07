const Joi = require("joi");
const { stableJson } = require("../redis/cache");
const indexTemplate = require("../../../docker/elasticsearch/properties-index-template.json");
const schema = Joi.object({
  propertyId: Joi.string().uuid().required(),
  version: Joi.number()
    .integer()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .required(),
  active: Joi.boolean().required(),
  deleted: Joi.boolean().required(),
  updatedAt: Joi.string().isoDate().required(),
  name: Joi.string(),
  description: Joi.string().allow(""),
  address: Joi.string(),
  city: Joi.string(),
  district: Joi.string().allow(""),
  countryCode: Joi.string().length(2),
  location: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lon: Joi.number().min(-180).max(180).required(),
  }).allow(null),
  amenityCodes: Joi.array().items(Joi.string()),
  minBasePrice: Joi.number().integer().min(0).allow(null),
  roomTypes: Joi.array().items(
    Joi.object({
      roomTypeId: Joi.string().uuid().required(),
      name: Joi.string().required(),
      basePrice: Joi.number().integer().min(0).required(),
      maxGuests: Joi.number().integer().min(1).required(),
      bedCount: Joi.number().integer().min(0).required(),
      bathroomCount: Joi.number().min(0).required(),
      roomCount: Joi.number().integer().min(0).required(),
    }).unknown(false),
  ),
}).unknown(false);
function validateSnapshot(snapshot, event) {
  if (
    schema.validate(snapshot, { convert: false }).error ||
    snapshot.propertyId !== event.aggregate_id ||
    snapshot.version !== event.aggregate_version ||
    (!snapshot.deleted &&
      (!snapshot.name || !snapshot.roomTypes || !snapshot.amenityCodes))
  )
    throw new Error("INVALID_SEARCH_SNAPSHOT");
  return snapshot;
}
function safeIndexName(name) {
  if (!/^[a-z][a-z0-9_-]{0,150}$/.test(name))
    throw new Error("INVALID_SEARCH_INDEX_NAME");
  return name;
}
function createPropertyIndex({
  client,
  index = "properties_read",
  requireAlias = true,
  refresh = "wait_for",
}) {
  safeIndexName(index);
  if (!["wait_for", false].includes(refresh))
    throw new Error("INVALID_REFRESH_MODE");
  return {
    index,
    async apply(event) {
      const snapshot = validateSnapshot(event.data.snapshot, event);
      const path = `/${index}/_doc/${snapshot.propertyId}`;
      try {
        await client.request(
          "PUT",
          `${path}?version=${snapshot.version}&version_type=external&refresh=${refresh}&require_alias=${requireAlias}`,
          snapshot,
        );
        return { updated: true };
      } catch (error) {
        if (error.status !== 409) throw error;
        const current = await client.request("GET", path);
        if (current._version < snapshot.version)
          throw new Error("SEARCH_VERSION_STATE_INVALID");
        if (
          current._version === snapshot.version &&
          stableJson(current._source) !== stableJson(snapshot)
        )
          throw new Error("SEARCH_VERSION_PAYLOAD_CONFLICT");
        // Even a no-op replay must establish visibility before cache invalidation.
        await client.request("POST", `/${index}/_refresh`);
        return { updated: false };
      }
    },
    refresh: () => client.request("POST", `/${index}/_refresh`),
  };
}
module.exports = {
  createPropertyIndex,
  validateSnapshot,
  safeIndexName,
  indexTemplate,
};
