const Joi = require("joi");
const { randomUUID } = require("node:crypto");
const { AppError } = require("../../shared/errors/app-error");
const {
  createPropertyRepository,
} = require("../properties/property.repository");

const text = Joi.string().trim().max(2000);
const propertyPatch = Joi.object({
  name: text,
  description: text.allow(null, ""),
  address_line: text,
  ward: text.allow(null, ""),
  city: text,
  district: text.allow(null, ""),
  country_code: Joi.string().length(2),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
  status: Joi.string().valid("ACTIVE", "INACTIVE"),
})
  .min(1)
  .unknown(false);
const roomPatch = Joi.object({
  name: text,
  description: text.allow(null, ""),
  max_guests: Joi.number().integer().min(1),
  bed_count: Joi.number().integer().min(0),
  bathroom_count: Joi.number().min(0),
})
  .min(1)
  .unknown(false);

function validatePatch(schema, input) {
  const { value, error } = schema.validate(input);
  if (error)
    throw new AppError(
      422,
      "INVALID_CATALOG_PATCH",
      "Thay đổi catalog không hợp lệ.",
    );
  return value;
}

function createCatalogWriteService({ db, outbox, cache }) {
  if (!outbox) throw new Error("Catalog writer requires transactional outbox");
  const repository = createPropertyRepository(db);

  async function lockRevision(trx, propertyId) {
    // Shared catalog-only maintenance fence. Reindex takes the exclusive form
    // for cutover; booking/payment transactions do not acquire this lock.
    await trx.raw("SELECT pg_advisory_xact_lock_shared(?)", [30802027]);
    await trx("catalog_versions")
      .insert({ property_id: propertyId })
      .onConflict("property_id")
      .ignore();
    return trx("catalog_versions")
      .where({ property_id: propertyId })
      .forUpdate()
      .first();
  }

  async function publishSnapshot(
    trx,
    propertyId,
    eventType,
    changedFields = [],
  ) {
    const property = await trx("properties").where({ id: propertyId }).first();
    const deleted = !property;
    const [revision] = await trx("catalog_versions")
      .where({ property_id: propertyId })
      .update({
        version: trx.raw("version + 1"),
        deleted,
        updated_at: trx.fn.now(),
      })
      .returning("version");
    const version = Number(revision.version);
    let snapshot = {
      propertyId,
      version,
      active: false,
      deleted: true,
      updatedAt: new Date().toISOString(),
    };
    if (property) {
      const [amenities, rooms] = await Promise.all([
        repository.getAmenities([propertyId], trx),
        repository.getRoomTypes([propertyId], {}, trx),
      ]);
      snapshot = {
        propertyId,
        name: property.name,
        description: property.description || "",
        address: property.address_line,
        city: property.city,
        district: property.district || "",
        countryCode: property.country_code,
        location:
          property.latitude !== null && property.longitude !== null
            ? {
                lat: Number(property.latitude),
                lon: Number(property.longitude),
              }
            : null,
        amenityCodes: amenities.map((a) => a.code),
        roomTypes: rooms.map((row) => ({
          roomTypeId: row.id,
          name: row.name,
          basePrice: Number(row.base_price),
          maxGuests: row.max_guests,
          bedCount: row.bed_count,
          bathroomCount: Number(row.bathroom_count),
          roomCount: row.room_count,
        })),
        minBasePrice: rooms.length
          ? Math.min(...rooms.map((row) => Number(row.base_price)))
          : null,
        version,
        active: property.status === "ACTIVE",
        deleted: false,
        updatedAt: new Date().toISOString(),
      };
    }
    return outbox.append(trx, {
      aggregateType: "catalog",
      aggregateId: propertyId,
      version,
      eventType,
      data: {
        property_id: propertyId,
        changed_fields: changedFields,
        snapshot,
      },
    });
  }

  async function invalidate(propertyIds, references = ["locations"]) {
    if (!cache) return;
    // Best effort only. M6's outbox consumer retries durable invalidation.
    const operations = [
      ...propertyIds.map((id) => cache.invalidate("property", id)),
      cache.invalidate("search", "pg"),
      ...references.map((kind) => cache.invalidate("reference", kind)),
    ];
    await Promise.allSettled(operations);
  }

  return {
    async updateProperty(propertyId, input) {
      const patch = validatePatch(propertyPatch, input);
      const event = await db.transaction(async (trx) => {
        const revision = await lockRevision(trx, propertyId);
        if (revision.deleted)
          throw new AppError(
            409,
            "PROPERTY_DELETED",
            "Không được dùng lại UUID đã xóa.",
          );
        const count = await trx("properties")
          .where({ id: propertyId })
          .update({ ...patch, updated_at: trx.fn.now() });
        if (!count)
          throw new AppError(
            404,
            "PROPERTY_NOT_FOUND",
            "Không tìm thấy property.",
          );
        return publishSnapshot(
          trx,
          propertyId,
          "PropertyUpserted",
          Object.keys(patch),
        );
      });
      await invalidate([propertyId]);
      return event;
    },

    async updateRoomType(roomTypeId, input) {
      const patch = validatePatch(roomPatch, input);
      const event = await db.transaction(async (trx) => {
        const room = await trx("room_types").where({ id: roomTypeId }).first();
        if (!room)
          throw new AppError(
            404,
            "ROOM_TYPE_NOT_FOUND",
            "Không tìm thấy room type.",
          );
        await lockRevision(trx, room.property_id);
        const changed = await trx("room_types")
          .where({ id: roomTypeId, property_id: room.property_id })
          .update({ ...patch, updated_at: trx.fn.now() });
        if (!changed)
          throw new AppError(
            409,
            "CATALOG_CHANGED",
            "Catalog đã thay đổi, hãy thử lại.",
          );
        return publishSnapshot(trx, room.property_id, "RoomTypeUpserted", [
          "roomTypes",
        ]);
      });
      await invalidate([event.aggregate_id]);
      return event;
    },

    async updateAmenity(amenityId, input) {
      const patch = validatePatch(
        Joi.object({ name: text, icon: text.allow(null, "") })
          .min(1)
          .unknown(false),
        input,
      );
      const events = await db.transaction(async (trx) => {
        const rows = await trx("property_amenities")
          .where({ amenity_id: amenityId })
          .orderBy("property_id")
          .select("property_id");
        for (const row of rows) await lockRevision(trx, row.property_id);
        const changed = await trx("amenities")
          .where({ id: amenityId })
          .update(patch);
        if (!changed)
          throw new AppError(
            404,
            "AMENITY_NOT_FOUND",
            "Không tìm thấy tiện nghi.",
          );
        await trx("catalog_reference_versions")
          .insert({ reference_kind: "amenity", reference_id: amenityId })
          .onConflict(["reference_kind", "reference_id"])
          .ignore();
        const [revision] = await trx("catalog_reference_versions")
          .where({ reference_kind: "amenity", reference_id: amenityId })
          .update({ version: trx.raw("version + 1") })
          .returning(["version", "aggregate_id"]);
        const result = [
          await outbox.append(trx, {
            aggregateType: "catalog",
            aggregateId: revision.aggregate_id,
            version: revision.version,
            eventType: "AmenityChanged",
            data: {
              property_ids: rows.map((row) => row.property_id),
              amenity_id: amenityId,
            },
          }),
        ];
        for (const row of rows)
          result.push(
            await publishSnapshot(trx, row.property_id, "PropertyUpserted", [
              "amenities",
            ]),
          );
        return result;
      });
      await invalidate(
        events.slice(1).map((event) => event.aggregate_id),
        ["amenities"],
      );
      return events;
    },

    async replaceImages(propertyId, input) {
      const images = validatePatch(
        Joi.array()
          .max(50)
          .items(
            Joi.object({
              url: Joi.string()
                .uri({ scheme: ["http", "https"] })
                .required(),
              altText: text.allow("", null),
            }).unknown(false),
          ),
        input,
      );
      const event = await db.transaction(async (trx) => {
        const revision = await lockRevision(trx, propertyId);
        if (
          revision.deleted ||
          !(await trx("properties").where({ id: propertyId }).first())
        )
          throw new AppError(
            404,
            "PROPERTY_NOT_FOUND",
            "Không tìm thấy property.",
          );
        await trx("property_images").where({ property_id: propertyId }).del();
        if (images.length)
          await trx("property_images").insert(
            images.map((image, index) => ({
              id: randomUUID(),
              property_id: propertyId,
              url: image.url,
              alt_text: image.altText || null,
              sort_order: index,
            })),
          );
        return publishSnapshot(trx, propertyId, "PropertyUpserted", ["images"]);
      });
      await invalidate([propertyId]);
      return event;
    },

    async deleteRoomType(roomTypeId) {
      const event = await db.transaction(async (trx) => {
        const room = await trx("room_types").where({ id: roomTypeId }).first();
        if (!room)
          throw new AppError(
            404,
            "ROOM_TYPE_NOT_FOUND",
            "Không tìm thấy room type.",
          );
        await lockRevision(trx, room.property_id);
        if (await trx("bookings").where({ room_type_id: roomTypeId }).first())
          throw new AppError(
            409,
            "ROOM_TYPE_HAS_BOOKINGS",
            "Không xóa lịch sử booking.",
          );
        await trx("rooms").where({ room_type_id: roomTypeId }).del();
        await trx("room_types").where({ id: roomTypeId }).del();
        return publishSnapshot(trx, room.property_id, "RoomTypeDeleted", [
          "roomTypes",
        ]);
      });
      await invalidate([event.aggregate_id]);
      return event;
    },

    async deleteProperty(propertyId) {
      const event = await db.transaction(async (trx) => {
        const revision = await lockRevision(trx, propertyId);
        if (revision.deleted) return null;
        const exists = await trx("properties")
          .where({ id: propertyId })
          .first();
        if (!exists)
          throw new AppError(
            404,
            "PROPERTY_NOT_FOUND",
            "Không tìm thấy property.",
          );
        const booking = await trx("bookings as b")
          .join("room_types as rt", "rt.id", "b.room_type_id")
          .where("rt.property_id", propertyId)
          .first("b.id");
        if (booking)
          throw new AppError(
            409,
            "PROPERTY_HAS_BOOKINGS",
            "Giữ lịch sử booking; chỉ đổi status INACTIVE.",
          );
        await trx("rooms").where({ property_id: propertyId }).del();
        await trx("room_types").where({ property_id: propertyId }).del();
        await trx("properties").where({ id: propertyId }).del();
        return publishSnapshot(trx, propertyId, "PropertyDeleted", ["deleted"]);
      });
      await invalidate([propertyId]);
      return event;
    },

    async repairProperty(propertyId) {
      const event = await db.transaction(async (trx) => {
        const revision = await lockRevision(trx, propertyId);
        const property = await trx("properties")
          .where({ id: propertyId })
          .first();
        if (revision.deleted && property)
          throw new AppError(
            409,
            "PROPERTY_UUID_REUSED",
            "UUID tombstone đã bị tạo lại thủ công; cần review.",
          );
        return publishSnapshot(
          trx,
          propertyId,
          property ? "PropertyUpserted" : "PropertyDeleted",
          ["repair"],
        );
      });
      await invalidate([propertyId]);
      return event;
    },
  };
}
module.exports = { createCatalogWriteService };
