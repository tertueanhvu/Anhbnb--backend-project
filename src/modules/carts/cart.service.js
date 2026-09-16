const { AppError } = require("../../shared/errors/app-error");
const { databaseDate } = require("../../shared/dates");

function selectionFromRow(row) {
  return {
    roomTypeId: row.room_type_id,
    checkIn: databaseDate(row.check_in),
    checkOut: databaseDate(row.check_out),
    roomQuantity: row.room_quantity,
    adults: row.adults,
    children: row.children,
  };
}

function createCartService({
  repository,
  availabilityService,
  db,
  clock = () => new Date(),
}) {
  async function hydrateItem(row) {
    try {
      const quote = await availabilityService.quoteSelection(
        selectionFromRow(row),
      );
      return {
        id: row.id,
        selection: selectionFromRow(row),
        property: {
          id: quote.roomType.property_id,
          name: quote.roomType.property_name,
        },
        roomType: {
          id: quote.roomType.id,
          name: quote.roomType.name,
          maxGuests: quote.roomType.max_guests,
          basePrice: Number(quote.roomType.base_price),
          roomCount: quote.roomType.room_count,
        },
        state: quote.available ? "AVAILABLE" : "UNAVAILABLE",
        bookableRooms: quote.bookableRooms,
        nightly: quote.nightly,
        price: {
          subtotal: quote.subtotal,
          total: quote.subtotal,
          discount: 0,
          currency: quote.roomType.currency,
        },
        quotedAt: clock().toISOString(),
      };
    } catch (error) {
      if (error.code === "ROOM_TYPE_NOT_FOUND") {
        return {
          id: row.id,
          selection: selectionFromRow(row),
          state: "REMOVED",
          quotedAt: clock().toISOString(),
        };
      }
      if (
        error.code === "STAY_OUTSIDE_CALENDAR" ||
        error.code === "INVALID_DATE_RANGE"
      ) {
        return {
          id: row.id,
          selection: selectionFromRow(row),
          state: "UNAVAILABLE",
          reason: error.code,
          quotedAt: clock().toISOString(),
        };
      }
      throw error;
    }
  }

  async function requireAvailable(selection) {
    const quote = await availabilityService.quoteSelection(selection);
    if (!quote.available) {
      throw new AppError(
        409,
        "ROOM_UNAVAILABLE",
        "Không còn đủ phòng cho toàn bộ thời gian đã chọn.",
      );
    }
    return quote;
  }

  return {
    async get(userId) {
      const cart = await repository.getOrCreate(userId);
      const rows = await repository.listItems(cart.id);
      const items = await Promise.all(rows.map(hydrateItem));
      const total = items
        .filter((item) => item.state === "AVAILABLE")
        .reduce((sum, item) => sum + item.price.total, 0);
      return {
        id: cart.id,
        items,
        estimatedTotal: total,
        currency: "VND",
        quotedAt: clock().toISOString(),
      };
    },

    async add(userId, input) {
      await requireAvailable(input);
      const row = await db.transaction(async (trx) => {
        const cart = await repository.getOrCreate(userId, trx);
        return repository.upsertItem(cart.id, input, trx);
      });
      return hydrateItem(row);
    },

    async update(userId, itemId, patch) {
      const current = await repository.findOwnedItem(userId, itemId);
      if (!current)
        throw new AppError(
          404,
          "CART_ITEM_NOT_FOUND",
          "Không tìm thấy cart item.",
        );
      const selection = { ...selectionFromRow(current), ...patch };
      await requireAvailable(selection);
      return hydrateItem(await repository.updateItem(itemId, selection));
    },

    async remove(userId, itemId) {
      const item = await repository.findOwnedItem(userId, itemId);
      if (!item)
        throw new AppError(
          404,
          "CART_ITEM_NOT_FOUND",
          "Không tìm thấy cart item.",
        );
      await repository.deleteItem(itemId);
    },

    async clear(userId) {
      const cart = await repository.findByUserId(userId);
      if (cart) await repository.clear(cart.id);
    },
  };
}

module.exports = { createCartService, selectionFromRow };
