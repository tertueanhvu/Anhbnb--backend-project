const {
  buildAvailabilityQuote,
  validateStayDates,
} = require("./availability.service");
const { AppError } = require("../../shared/errors/app-error");
function createBulkQuoteService({ repository, env, clock = () => new Date() }) {
  return {
    async quote(propertyIds, selection, { deadline = Date.now() + 2000 } = {}) {
      const { nights, nightCount } = validateStayDates(
        selection.checkIn,
        selection.checkOut,
        env,
        clock(),
      );
      const ids = [...new Set(propertyIds)],
        result = new Map();
      if (ids.length > 1000)
        throw new AppError(
          422,
          "SEARCH_TOO_BROAD",
          "Thêm bộ lọc để thu hẹp tìm kiếm.",
        );
      for (let start = 0; start < ids.length; start += 100) {
        if (Date.now() > deadline)
          throw new AppError(
            422,
            "SEARCH_TOO_BROAD",
            "Tìm kiếm vượt thời gian cho phép; hãy thêm bộ lọc.",
          );
        const { roomTypes, rows } = await repository.read(
          ids.slice(start, start + 100),
          selection,
        );
        const grouped = new Map();
        for (const row of rows) {
          if (!grouped.has(row.room_type_id)) grouped.set(row.room_type_id, []);
          grouped.get(row.room_type_id).push(row);
        }
        for (const roomType of roomTypes) {
          if (
            selection.adults + selection.children >
            selection.roomQuantity * roomType.max_guests
          )
            continue;
          const matrix = grouped.get(roomType.id) || [];
          const quote = buildAvailabilityQuote({
            rows: matrix,
            roomCount: roomType.room_count,
            nights,
            roomQuantity: selection.roomQuantity,
          });
          result.set(roomType.id, { roomType, nights, nightCount, ...quote });
        }
      }
      if (Date.now() > deadline)
        throw new AppError(
          422,
          "SEARCH_TOO_BROAD",
          "Tìm kiếm vượt thời gian cho phép; hãy thêm bộ lọc.",
        );
      return result;
    },
  };
}
module.exports = { createBulkQuoteService };
