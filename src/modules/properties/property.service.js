const { AppError } = require("../../shared/errors/app-error");
const { paginationMeta, parsePagination } = require("../../shared/pagination");

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

  function sortProperties(items, sort) {
    const multiplier = sort === "price_desc" ? -1 : 1;
    return items.sort((a, b) => {
      let comparison = 0;
      if (sort === "price_asc" || sort === "price_desc")
        comparison = a.startingPrice - b.startingPrice;
      if (sort === "name_asc") comparison = a.name.localeCompare(b.name);
      return comparison * multiplier || a.id.localeCompare(b.id);
    });
  }

  return {
    async list(query) {
      const { page, limit, offset } = parsePagination(query);
      const properties = await hydrate(await repository.list(query), query);
      const sorted = sortProperties(properties, query.sort);
      return {
        data: sorted.slice(offset, offset + limit),
        meta: {
          ...paginationMeta(page, limit, sorted.length),
          quotedAt: clock().toISOString(),
        },
      };
    },

    async detail(propertyId, query) {
      const property = await repository.findActiveById(propertyId);
      if (!property)
        throw new AppError(
          404,
          "PROPERTY_NOT_FOUND",
          "Không tìm thấy property.",
        );
      const [result] = await hydrate([property], query, {
        filterUnavailable: false,
      });
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
