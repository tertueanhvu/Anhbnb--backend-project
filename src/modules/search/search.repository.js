const Joi = require("joi");
const { AppError } = require("../../shared/errors/app-error");
const { safeIndexName } = require("../../infrastructure/search/property-index");
function buildSearchQuery(
  query,
  { after, size = query.limit, from = (query.page - 1) * query.limit } = {},
) {
  const filters = [{ term: { active: true } }, { term: { deleted: false } }];
  // Preserve Phase 1's case-insensitive substring city/district matching.
  const escaped = (text) => text.replace(/[\\*?]/g, "\\$&");
  for (const field of ["city", "district"])
    if (query[field])
      filters.push({
        wildcard: {
          [field]: {
            value: `*${escaped(query[field])}*`,
            case_insensitive: true,
          },
        },
      });
  if (query.amenity?.length)
    filters.push({ terms: { amenityCodes: query.amenity } });
  if (query.lat !== undefined)
    filters.push({
      geo_distance: {
        distance: `${query.radiusKm}km`,
        location: { lat: query.lat, lon: query.lon },
      },
    });
  const room = [{ range: { "roomTypes.roomCount": { gt: 0 } } }];
  for (const [field, min, max] of [
    ["basePrice", query.minPrice, query.maxPrice],
    ["bedCount", query.minBedrooms],
    ["bathroomCount", query.minBathrooms],
  ]) {
    if (min !== undefined || max !== undefined)
      room.push({
        range: {
          [`roomTypes.${field}`]: {
            ...(min === undefined ? {} : { gte: min }),
            ...(max === undefined ? {} : { lte: max }),
          },
        },
      });
  }
  // All filters refer to the SAME nested room type. No date/guest predicate:
  // those dimensions always get canonical PostgreSQL quotes per request.
  filters.push({
    nested: { path: "roomTypes", query: { bool: { filter: room } } },
  });
  let sort = [{ _score: "desc" }, { propertyId: "asc" }];
  if (query.sort === "name_asc")
    sort = [{ "name.keyword": "asc" }, { propertyId: "asc" }];
  if (query.sort === "price_asc" || query.sort === "price_desc")
    sort = [
      {
        "roomTypes.basePrice": {
          order: query.sort === "price_asc" ? "asc" : "desc",
          mode: "min",
          nested: { path: "roomTypes", filter: { bool: { filter: room } } },
        },
      },
      { propertyId: "asc" },
    ];
  if (query.sort === "distance")
    sort = [
      {
        _geo_distance: {
          location: { lat: query.lat, lon: query.lon },
          order: "asc",
          unit: "km",
          mode: "min",
        },
      },
      { propertyId: "asc" },
    ];
  return {
    size,
    ...(after ? { search_after: after } : { from }),
    track_total_hits: true,
    _source: false,
    sort,
    timeout: "1500ms",
    query: {
      bool: {
        filter: filters,
        ...(query.q
          ? {
              must: [
                {
                  multi_match: {
                    query: query.q,
                    fields: ["name^3", "address", "description"],
                  },
                },
              ],
            }
          : {}),
      },
    },
  };
}
const pageSchema = Joi.object({
  ids: Joi.array().items(Joi.string().uuid()).required(),
  total: Joi.number().integer().min(0).required(),
  lastSort: Joi.array()
    .items(Joi.alternatives().try(Joi.string(), Joi.number(), Joi.valid(null)))
    .allow(null)
    .required(),
}).unknown(false);
const isDiscoveryPage = (value) =>
  !pageSchema.validate(value, { convert: false }).error;
function createSearchRepository({
  client,
  index = "properties_read",
  metrics,
}) {
  safeIndexName(index);
  return {
    async page(query, options) {
      metrics?.increment("search.es.source_calls");
      const started = Date.now();
      try {
        const result = await client.request(
          "POST",
          `/${index}/_search`,
          buildSearchQuery(query, options),
        );
        if (
          result.timed_out ||
          result._shards?.failed ||
          result.hits.total.relation !== "eq"
        )
          throw new Error("INCOMPLETE_SEARCH_RESULT");
        return {
          ids: result.hits.hits.map((hit) => hit._id),
          total: result.hits.total.value,
          lastSort: result.hits.hits.at(-1)?.sort || null,
        };
      } catch {
        throw new AppError(
          503,
          "SEARCH_UNAVAILABLE",
          "Search hiện không phản hồi; thử lại sau.",
        );
      } finally {
        metrics?.increment("search.es.source_ms", Date.now() - started);
      }
    },
  };
}
module.exports = { createSearchRepository, buildSearchQuery, isDiscoveryPage };
