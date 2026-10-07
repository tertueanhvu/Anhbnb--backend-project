const { AppError } = require("../../shared/errors/app-error");
const { paginationMeta, parsePagination } = require("../../shared/pagination");
const { createSearchService } = require("../search/search.service");
const {
  isPublicCatalog,
  normalizeDiscoveryQuery,
} = require("./public-catalog");

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const group = result.get(row[key]) || [];
    group.push(row);
    result.set(row[key], group);
  }
  return result;
}

function propertyDto(property, images, amenities, roomTypes) {
  return {
    id: property.id,
    slug: property.slug,
    name: property.name,
    description: property.description,
    location: {
      addressLine: property.address_line,
      ward: property.ward,
      district: property.district,
      city: property.city,
      countryCode: property.country_code,
      latitude: property.latitude === null ? null : Number(property.latitude),
      longitude:
        property.longitude === null ? null : Number(property.longitude),
    },
    checkInTime: property.check_in_time,
    checkOutTime: property.check_out_time,
    images: images.map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.alt_text,
      sortOrder: image.sort_order,
    })),
    amenities: amenities.map((amenity) => ({
      id: amenity.id,
      code: amenity.code,
      name: amenity.name,
      icon: amenity.icon,
    })),
    roomTypes,
    startingPrice: roomTypes.length
      ? Math.min(...roomTypes.map((room) => room.basePrice))
      : null,
    currency: "VND",
  };
}

function roomTypeDto(row, quote) {
  const dto = {
    id: row.id,
    name: row.name,
    description: row.description,
    maxGuests: row.max_guests,
    bedCount: row.bed_count,
    bathroomCount: Number(row.bathroom_count),
    basePrice: Number(row.base_price),
    currency: row.currency,
    roomCount: row.room_count,
  };
  if (quote) {
    dto.available = quote.available;
    dto.bookableRooms = quote.bookableRooms;
    dto.nightly = quote.nightly;
    dto.price = {
      subtotal: quote.subtotal,
      discount: 0,
      total: quote.subtotal,
      currency: row.currency,
    };
  }
  return dto;
}

function createPropertyService({
  repository,
  availabilityService,
  bulkQuoteService,
  search,
  cache,
  cacheTtl = { property: 300, search: 30 },
  clock = () => new Date(),
}) {
  async function hydrate(properties, query, { filterUnavailable = true } = {}) {
    const ids = properties.map((property) => property.id);
    const [images, amenities, roomTypeRows] = await Promise.all([
      repository.getImages(ids),
      repository.getAmenities(ids),
      repository.getRoomTypes(ids, query),
    ]);
    const imagesByProperty = groupBy(images, "property_id");
    const amenitiesByProperty = groupBy(amenities, "property_id");
    const roomTypesByProperty = groupBy(roomTypeRows, "property_id");
    const withStay = Boolean(query.checkIn && query.checkOut);
    const result = [];

    for (const property of properties) {
      const roomTypes = [];
      for (const row of roomTypesByProperty.get(property.id) || []) {
        let quote;
        if (withStay) {
          if (
            query.adults + query.children >
            query.roomQuantity * row.max_guests
          )
            continue;
          quote = await availabilityService.quoteSelection({
            roomTypeId: row.id,
            propertyId: property.id,
            checkIn: query.checkIn,
            checkOut: query.checkOut,
            roomQuantity: query.roomQuantity,
            adults: query.adults,
            children: query.children,
          });
          if (filterUnavailable && !quote.available) continue;
        }
        roomTypes.push(roomTypeDto(row, quote));
      }
      if (roomTypes.length) {
        result.push(
          propertyDto(
            property,
            imagesByProperty.get(property.id) || [],
            amenitiesByProperty.get(property.id) || [],
            roomTypes,
          ),
        );
      }
    }
    return result;
  }

  function sortProperties(items, sort, withStay = false) {
    const multiplier = sort === "price_desc" ? -1 : 1;
    return items.sort((a, b) => {
      let comparison = 0;
      if (sort === "price_asc" || sort === "price_desc")
        comparison = withStay
          ? Math.min(...a.roomTypes.map((room) => room.price.total)) -
            Math.min(...b.roomTypes.map((room) => room.price.total))
          : a.startingPrice - b.startingPrice;
      if (sort === "name_asc") comparison = a.name.localeCompare(b.name);
      return comparison * multiplier || a.id.localeCompare(b.id);
    });
  }

  async function readCatalog(options) {
    return cache
      ? cache.read({ ...options, validate: isPublicCatalog })
      : options.load();
  }

  async function quoteCatalog(
    items,
    query,
    filterUnavailable = true,
    options = {},
  ) {
    if (!query.checkIn || !query.checkOut) return items;
    const bulk = bulkQuoteService
      ? await bulkQuoteService.quote(
          items.map((item) => item.id),
          query,
          options,
        )
      : null;
    const result = [];
    for (const property of items) {
      const roomTypes = [];
      for (const room of property.roomTypes) {
        if (
          !bulk &&
          query.adults + query.children > query.roomQuantity * room.maxGuests
        )
          continue;
        const quote = bulk
          ? bulk.get(room.id)
          : await availabilityService.quoteSelection({
              roomTypeId: room.id,
              propertyId: property.id,
              checkIn: query.checkIn,
              checkOut: query.checkOut,
              roomQuantity: query.roomQuantity,
              adults: query.adults,
              children: query.children,
            });
        if (!quote || (bulk && quote.roomType.property_id !== property.id))
          continue;
        if (filterUnavailable && !quote.available) continue;
        roomTypes.push({
          ...room,
          ...(bulk ? roomTypeDto(quote.roomType) : {}),
          available: quote.available,
          bookableRooms: quote.bookableRooms,
          nightly: quote.nightly,
          price: {
            subtotal: quote.subtotal,
            discount: 0,
            total: quote.subtotal,
            currency: quote.roomType.currency,
          },
        });
      }
      if (roomTypes.length)
        result.push({
          ...property,
          roomTypes,
          startingPrice: Math.min(...roomTypes.map((room) => room.basePrice)),
        });
    }
    return result;
  }

  const searchService = search
    ? createSearchService({
        ...search,
        cache,
        ttlSeconds: cacheTtl.search,
        clock,
        quoteCatalog,
        sortProperties,
        loadCatalog: async (ids, query) => {
          const rows = await repository.findActiveByIds(ids);
          const positions = new Map(ids.map((id, index) => [id, index]));
          rows.sort((a, b) => positions.get(a.id) - positions.get(b.id));
          return hydrate(rows, query);
        },
      })
    : null;

  return {
    async list(query) {
      if (searchService) return searchService.list(query);
      if (query.lat !== undefined || query.cursor)
        throw new AppError(
          503,
          "SEARCH_BACKEND_REQUIRED",
          "Geo/cursor search cần backend Elasticsearch đã sẵn sàng.",
        );
      const deadline = Date.now() + 2000;
      const { page, limit, offset } = parsePagination(query);
      const discovery = normalizeDiscoveryQuery(query);
      const catalog = await readCatalog({
        kind: "search",
        scope: "pg",
        query: discovery,
        ttlSeconds: cacheTtl.search,
        load: async () => hydrate(await repository.list(discovery), discovery),
      });
      // Do not cache this step or paginate before availability filtering.
      const properties = await quoteCatalog(catalog, query, true, { deadline });
      const sorted = sortProperties(
        properties,
        query.sort,
        Boolean(query.checkIn),
      );
      return {
        data: sorted.slice(offset, offset + limit),
        meta: {
          ...paginationMeta(page, limit, sorted.length),
          quotedAt: clock().toISOString(),
        },
      };
    },

    async detail(propertyId, query) {
      const catalog = await readCatalog({
        kind: "property",
        scope: propertyId.toLowerCase(),
        ttlSeconds: cacheTtl.property,
        load: async () => {
          const property = await repository.findActiveById(propertyId);
          if (!property)
            throw new AppError(
              404,
              "PROPERTY_NOT_FOUND",
              "Không tìm thấy property.",
            );
          const items = await hydrate(
            [property],
            {},
            { filterUnavailable: false },
          );
          if (!items.length)
            throw new AppError(
              404,
              "PROPERTY_NOT_FOUND",
              "Property không có loại phòng đang bán.",
            );
          return items;
        },
      });
      const [result] = await quoteCatalog(catalog, query, false);
      if (!result)
        throw new AppError(
          404,
          "PROPERTY_NOT_FOUND",
          "Property không có loại phòng đang bán.",
        );
      if (query.checkIn && query.checkOut)
        result.quotedAt = clock().toISOString();
      return result;
    },
  };
}

module.exports = { createPropertyService, propertyDto, roomTypeDto };
