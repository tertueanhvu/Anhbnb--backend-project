const { AppError } = require("../../shared/errors/app-error");
const {
  addDays,
  databaseDate,
  diffDays,
  enumerateNights,
  parsePlainDate,
  todayInTimezone,
} = require("../../shared/dates");
const { asVndInteger, sumVnd } = require("../../shared/money");

function validateStayDates(checkIn, checkOut, env, now = new Date()) {
  if (!parsePlainDate(checkIn) || !parsePlainDate(checkOut)) {
    throw new AppError(
      400,
      "INVALID_DATE_RANGE",
      "Ngày phải có định dạng YYYY-MM-DD hợp lệ.",
    );
  }
  const nightCount = diffDays(checkIn, checkOut);
  const today = todayInTimezone(env.businessTimezone, now);
  if (checkIn < today || nightCount < 1 || nightCount > env.maxStayNights) {
    throw new AppError(
      400,
      "INVALID_DATE_RANGE",
      "Khoảng ngày lưu trú không hợp lệ.",
    );
  }
  return { nights: enumerateNights(checkIn, checkOut), nightCount, today };
}

function groupMatrix(rows) {
  const byRoom = new Map();
  for (const row of rows) {
    const room = byRoom.get(row.room_id) || {
      roomId: row.room_id,
      roomCode: row.room_code,
      nights: [],
    };
    room.nights.push({
      date: databaseDate(row.stay_date),
      price: asVndInteger(row.price),
      status: row.status,
      bookingId: row.booking_id,
      bookingStatus: row.booking_status,
      holdExpiresAt: row.hold_expires_at,
    });
    byRoom.set(row.room_id, room);
  }
  return [...byRoom.values()].sort((a, b) =>
    a.roomCode.localeCompare(b.roomCode),
  );
}

function buildAvailabilityQuote({ rows, roomCount, nights, roomQuantity }) {
  if (rows.length !== roomCount * nights.length) {
    throw new AppError(
      400,
      "STAY_OUTSIDE_CALENDAR",
      "Khoảng ngày nằm ngoài lịch đang mở bán.",
    );
  }
  const rooms = groupMatrix(rows);
  const bookable = rooms.filter(
    (room) =>
      room.nights.length === nights.length &&
      room.nights.every((night) => night.status === "OPEN"),
  );
  const selected = bookable.slice(0, roomQuantity);
  const nightly = nights.map((date) => {
    const rowsForNight = rooms
      .map((room) => room.nights.find((night) => night.date === date))
      .filter(Boolean);
    const selectedPrice = selected[0]?.nights.find(
      (night) => night.date === date,
    )?.price;
    return {
      date,
      unitPrice: selectedPrice ?? rowsForNight[0]?.price ?? null,
      openRooms: rowsForNight.filter((night) => night.status === "OPEN").length,
    };
  });
  const subtotal = sumVnd(
    selected.flatMap((room) => room.nights.map((night) => night.price)),
  );
  return {
    available: bookable.length >= roomQuantity,
    bookableRooms: bookable.length,
    selectedRooms: selected,
    nightly,
    subtotal,
  };
}

function validateCapacity({ adults, children, roomQuantity, maxGuests }) {
  if (adults + children > roomQuantity * maxGuests) {
    throw new AppError(
      409,
      "GUEST_CAPACITY_EXCEEDED",
      "Số khách vượt sức chứa của số phòng đã chọn.",
    );
  }
}

function createAvailabilityService({
  repository,
  env,
  clock = () => new Date(),
}) {
  async function quoteSelection(selection, options = {}) {
    const { checkIn, checkOut, roomQuantity, adults, children } = selection;
    const { nights, nightCount } = validateStayDates(
      checkIn,
      checkOut,
      env,
      clock(),
    );
    const roomType = await repository.getRoomType(
      selection.roomTypeId,
      options.trx,
    );
    if (!roomType || roomType.property_status !== "ACTIVE") {
      throw new AppError(
        404,
        "ROOM_TYPE_NOT_FOUND",
        "Không tìm thấy loại phòng.",
      );
    }
    if (selection.propertyId && roomType.property_id !== selection.propertyId) {
      throw new AppError(
        404,
        "ROOM_TYPE_NOT_FOUND",
        "Loại phòng không thuộc property này.",
      );
    }
    if (roomType.room_count < 1) {
      throw new AppError(
        404,
        "ROOM_TYPE_NOT_FOUND",
        "Loại phòng không còn phòng vật lý.",
      );
    }
    validateCapacity({
      adults,
      children,
      roomQuantity,
      maxGuests: roomType.max_guests,
    });
    const rows = await repository.getMatrix(
      {
        roomTypeId: selection.roomTypeId,
        checkIn,
        checkOut,
        lock: options.lock || false,
      },
      options.trx,
    );
    const quote = buildAvailabilityQuote({
      rows,
      roomCount: roomType.room_count,
      nights,
      roomQuantity,
    });
    return { roomType, rows, nights, nightCount, ...quote };
  }

  return {
    quoteSelection,

    async getAvailability(input) {
      const quote = await quoteSelection(input);
      return {
        available: quote.available,
        propertyId: quote.roomType.property_id,
        roomTypeId: quote.roomType.id,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights: quote.nightCount,
        requestedRooms: input.roomQuantity,
        roomCount: quote.roomType.room_count,
        bookableRooms: quote.bookableRooms,
        nightly: quote.nightly,
        price: {
          subtotal: quote.subtotal,
          discount: 0,
          total: quote.subtotal,
          currency: quote.roomType.currency,
        },
        quotedAt: clock().toISOString(),
      };
    },

    async extendWindow(trx) {
      const today = todayInTimezone(env.businessTimezone, clock());
      const stayDate = addDays(today, env.availabilityWindowDays - 1);
      const rooms = await repository.listRoomsWithBasePrice(trx);
      const rows = rooms.map((room) => ({
        room_id: room.room_id,
        stay_date: stayDate,
        price: asVndInteger(room.base_price),
        status: "OPEN",
        booking_id: null,
        updated_at: clock(),
      }));
      return repository.insertWindowRows(rows, trx);
    },
  };
}

module.exports = {
  buildAvailabilityQuote,
  createAvailabilityService,
  groupMatrix,
  validateCapacity,
  validateStayDates,
};
