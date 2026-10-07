const Joi = require("joi");
const propertyTypes = new Set([
  "PropertyUpserted",
  "PropertyDeleted",
  "RoomTypeUpserted",
  "RoomTypeDeleted",
]);
const uuid = Joi.string().uuid().required();
function createCacheInvalidator({ inbox, cache }) {
  const name = "cache-invalidator-v1";
  return {
    name,
    topics: ["catalog"],
    async handle(event) {
      if (event.aggregate_type !== "catalog")
        throw new Error("INVALID_CATALOG_EVENT");
      return inbox.external(name, event.event_id, async () => {
        if (event.event_type === "CatalogFreshnessProbe") return;
        let ids;
        if (propertyTypes.has(event.event_type)) {
          if (
            uuid.validate(event.data.property_id).error ||
            event.data.property_id !== event.aggregate_id
          )
            throw new Error("INVALID_PROPERTY_EVENT");
          ids = [event.data.property_id];
        } else if (event.event_type === "AmenityChanged") {
          if (
            Joi.array().items(uuid).required().validate(event.data.property_ids)
              .error
          )
            throw new Error("INVALID_AMENITY_EVENT");
          ids = event.data.property_ids;
          await cache.invalidate("reference", "amenities");
        } else throw new Error("UNSUPPORTED_CATALOG_EVENT");
        for (const id of ids) await cache.invalidate("property", id);
        await cache.invalidate("reference", "locations");
        await cache.invalidate("search", "pg");
        // Only the ES indexer invalidates search:es, AFTER visibility refresh.
      });
    },
  };
}
module.exports = { createCacheInvalidator };
