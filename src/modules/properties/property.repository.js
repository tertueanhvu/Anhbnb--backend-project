function createPropertyRepository(db) {
  return {
    async list(filters, trx = db) {
      const query = trx("properties as p")
        .where("p.status", "ACTIVE")
        .select("p.*");
      if (filters.city) query.whereILike("p.city", `%${filters.city}%`);
      if (filters.district)
        query.whereILike("p.district", `%${filters.district}%`);
      if (filters.q) {
        query.where((builder) =>
          builder
            .whereILike("p.name", `%${filters.q}%`)
            .orWhereILike("p.address_line", `%${filters.q}%`)
            .orWhereILike("p.city", `%${filters.q}%`)
            .orWhereILike("p.district", `%${filters.q}%`),
        );
      }
      if (filters.amenity) {
        const codes = Array.isArray(filters.amenity)
          ? filters.amenity
          : [filters.amenity];
        query.whereExists(
          trx("property_amenities as pa")
            .join("amenities as a", "a.id", "pa.amenity_id")
            .whereRaw("pa.property_id = p.id")
            .whereIn("a.code", codes),
        );
      }
      if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
        query.whereExists(
          trx("room_types as rt")
            .join("rooms as r", "r.room_type_id", "rt.id")
            .whereRaw("rt.property_id = p.id")
            .modify((builder) => {
              if (filters.minPrice !== undefined)
                builder.where("rt.base_price", ">=", filters.minPrice);
              if (filters.maxPrice !== undefined)
                builder.where("rt.base_price", "<=", filters.maxPrice);
            }),
        );
      }
      return query.orderBy("p.id");
    },

    findActiveById(id, trx = db) {
      return trx("properties").where({ id, status: "ACTIVE" }).first();
    },

    getImages(propertyIds, trx = db) {
      if (!propertyIds.length) return [];
      return trx("property_images")
        .whereIn("property_id", propertyIds)
        .orderBy([
          { column: "property_id" },
          { column: "sort_order" },
          { column: "id" },
        ]);
    },

    getAmenities(propertyIds, trx = db) {
      if (!propertyIds.length) return [];
      return trx("property_amenities as pa")
        .join("amenities as a", "a.id", "pa.amenity_id")
        .whereIn("pa.property_id", propertyIds)
        .select("pa.property_id", "a.id", "a.code", "a.name", "a.icon")
        .orderBy(["pa.property_id", "a.code"]);
    },

    getRoomTypes(propertyIds, filters = {}, trx = db) {
      if (!propertyIds.length) return [];
      const query = trx("room_types as rt")
        .join("rooms as r", "r.room_type_id", "rt.id")
        .whereIn("rt.property_id", propertyIds)
        .groupBy("rt.id")
        .select("rt.*", trx.raw("count(r.id)::integer as room_count"));
      if (filters.minPrice !== undefined)
        query.where("rt.base_price", ">=", filters.minPrice);
      if (filters.maxPrice !== undefined)
        query.where("rt.base_price", "<=", filters.maxPrice);
      if (filters.minBedrooms !== undefined)
        query.where("rt.bed_count", ">=", filters.minBedrooms);
      if (filters.minBathrooms !== undefined)
        query.where("rt.bathroom_count", ">=", filters.minBathrooms);
      return query.orderBy(["rt.property_id", "rt.base_price", "rt.id"]);
    },
  };
}

module.exports = { createPropertyRepository };
