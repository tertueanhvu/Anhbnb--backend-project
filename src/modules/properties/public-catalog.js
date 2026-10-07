const Joi = require("joi");
const nullableText = Joi.string().allow("", null);
const room = Joi.object({
  id: Joi.string().uuid().required(),
  name: Joi.string().required(),
  description: nullableText,
  maxGuests: Joi.number().required(),
  bedCount: Joi.number().required(),
  bathroomCount: Joi.number().required(),
  basePrice: Joi.number().required(),
  currency: Joi.string().required(),
  roomCount: Joi.number().required(),
}).unknown(false);
const property = Joi.object({
  id: Joi.string().uuid().required(),
  slug: Joi.string().required(),
  name: Joi.string().required(),
  description: nullableText,
  location: Joi.object({
    addressLine: nullableText,
    ward: nullableText,
    district: nullableText,
    city: Joi.string(),
    countryCode: Joi.string(),
    latitude: Joi.number().allow(null),
    longitude: Joi.number().allow(null),
  })
    .unknown(false)
    .required(),
  checkInTime: Joi.string().allow(null).required(),
  checkOutTime: Joi.string().allow(null).required(),
  images: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().uuid(),
        url: Joi.string(),
        altText: nullableText,
        sortOrder: Joi.number(),
      }).unknown(false),
    )
    .required(),
  amenities: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().uuid(),
        code: Joi.string(),
        name: Joi.string(),
        icon: nullableText,
      }).unknown(false),
    )
    .required(),
  roomTypes: Joi.array().items(room).required(),
  startingPrice: Joi.number().allow(null).required(),
  currency: Joi.string().required(),
}).unknown(false);

function isPublicCatalog(value) {
  return !Joi.array()
    .items(property)
    .required()
    .validate(value, { convert: false }).error;
}

function normalizeDiscoveryQuery(query) {
  const normalized = {
    page: query.page || 1,
    limit: query.limit || 20,
    sort: query.sort || "recommended",
    locale: "vi-VN",
    currency: "VND",
    contractVersion: 1,
  };
  for (const field of ["q", "city", "district"]) {
    if (query[field])
      normalized[field] = query[field]
        .trim()
        .normalize("NFC")
        .replace(/\s+/gu, " ")
        .toLowerCase();
  }
  for (const field of [
    "minPrice",
    "maxPrice",
    "minBedrooms",
    "minBathrooms",
    "lat",
    "lon",
    "radiusKm",
  ]) {
    if (query[field] !== undefined) normalized[field] = Number(query[field]);
  }
  if (query.cursor) normalized.cursor = query.cursor;
  if (query.amenity)
    normalized.amenity = [
      ...new Set(
        [query.amenity].flat().map((code) => code.trim().normalize("NFC")),
      ),
    ].sort();
  // Stay/capacity fields are deliberately excluded: every dated request re-quotes in PG.
  return normalized;
}

module.exports = { isPublicCatalog, normalizeDiscoveryQuery };
