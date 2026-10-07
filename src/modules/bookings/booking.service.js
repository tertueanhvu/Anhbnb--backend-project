const { createHash, randomBytes } = require("node:crypto");
const { AppError } = require("../../shared/errors/app-error");
const { paginationMeta, parsePagination } = require("../../shared/pagination");
const { databaseDate, todayInTimezone } = require("../../shared/dates");
const { transactionWithRetry } = require("../../db/transaction-retry");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function createBookingCode(now = new Date()) {
  const date = now.toISOString().slice(2, 10).replaceAll("-", "");
  return `BK${date}${randomBytes(4).toString("hex").toUpperCase()}`;
}

function selectionFromCartItem(item) {
  return {
    roomTypeId: item.room_type_id,
    checkIn: databaseDate(item.check_in),
    checkOut: databaseDate(item.check_out),
    roomQuantity: item.room_quantity,
    adults: item.adults,
    children: item.children,
  };
}

function bookingSummary(row) {
  return {
    id: row.id,
    bookingCode: row.booking_code,
    status: row.status,
    property: row.property_id
      ? { id: row.property_id, name: row.property_name }
      : undefined,
    roomType: { id: row.room_type_id, name: row.room_type_name },
    checkIn: databaseDate(row.check_in),
    checkOut: databaseDate(row.check_out),
    nightCount: row.night_count,
    roomQuantity: row.room_quantity,
    adults: row.adults,
    children: row.children,
    price: {
      subtotal: Number(row.subtotal),
      discount: Number(row.discount),
      total: Number(row.total_amount),
      currency: row.currency,
      averageNightlyRate: Math.round(
        Number(row.subtotal) / row.night_count / row.room_quantity,
      ),
    },
    holdExpiresAt: row.hold_expires_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

function createBookingService({
  db,
  repository,
  availabilityService,
  env,
  bookingLock,
  clock = () => new Date(),
}) {
  async function detail(userId, bookingId, trx = db) {
    const booking = await repository.findOwnedById(userId, bookingId, trx);
    if (!booking)
      throw new AppError(404, "BOOKING_NOT_FOUND", "Không tìm thấy booking.");
    const [rooms, nights, payments] = await Promise.all([
      repository.getAssignedRooms(bookingId, trx),
      repository.getNights(bookingId, trx),
      repository.getPayments(bookingId, trx),
    ]);
    return {
      ...bookingSummary(booking),
      contact: {
        fullName: booking.contact_full_name,
        email: booking.contact_email,
        phone: booking.contact_phone,
      },
      specialRequests: booking.special_requests,
      cancellationReason: booking.cancellation_reason,
      rooms: rooms.map((room) => ({
        roomId: room.room_id,
        roomCode: room.room_code,
      })),
      nights: nights.map((night) => ({
        roomId: night.room_id,
        roomCode: night.room_code,
        date: databaseDate(night.stay_date),
        price: Number(night.price),
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        status: payment.status,
        amount: Number(payment.amount),
        currency: payment.currency,
        expiresAt: payment.expires_at,
        paidAt: payment.paid_at,
      })),
    };
  }

  function assertSameRequest(existing, requestFingerprint) {
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key đã được dùng cho payload khác.",
      );
    }
  }

  const service = {
    async create(userId, key, body, resourceRetries = 0) {
      if (!key || key.length > 200) {
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Thiếu Idempotency-Key hợp lệ.",
        );
      }
      const requestFingerprint = fingerprint(body);
      const existing = await repository.findByIdempotency(userId, key);
      if (existing) {
        assertSameRequest(existing, requestFingerprint);
        return { booking: await detail(userId, existing.id), reused: true };
      }

      // Pre-read only chooses the contention resource; ownership/selection is
      // checked again inside PostgreSQL, which is still the authority.
      const cartItem = body.cartItemId
        ? await repository.findOwnedCartItem(userId, body.cartItemId)
        : null;
      if (body.cartItemId && !cartItem) {
        throw new AppError(
          404,
          "CART_ITEM_NOT_FOUND",
          "Không tìm thấy cart item.",
        );
      }
      const lockRoomTypeId = cartItem?.room_type_id || body.roomTypeId;
      const release = bookingLock
        ? await bookingLock.acquire(lockRoomTypeId)
        : async () => {};
      let bookingId;
      let resourceChanged = false;
      try {
        bookingId = await transactionWithRetry(db, async (trx) => {
          const raced = await repository.findByIdempotency(
            userId,
            key,
            trx,
            true,
          );
          if (raced) {
            assertSameRequest(raced, requestFingerprint);
            return raced.id;
          }

          let selection;
          if (body.cartItemId) {
            const item = await repository.findOwnedCartItem(
              userId,
              body.cartItemId,
              trx,
            );
            if (!item)
              throw new AppError(
                404,
                "CART_ITEM_NOT_FOUND",
                "Không tìm thấy cart item.",
              );
            selection = selectionFromCartItem(item);
            if (selection.roomTypeId !== lockRoomTypeId) {
              throw new AppError(
                409,
                "CART_ROOM_TYPE_CHANGED",
                "Cart item đã đổi loại phòng. Hãy thử lại cùng Idempotency-Key.",
              );
            }
          } else {
            selection = {
              roomTypeId: body.roomTypeId,
              checkIn: body.checkIn,
              checkOut: body.checkOut,
              roomQuantity: body.roomQuantity,
              adults: body.adults,
              children: body.children,
            };
          }

          let quote = await availabilityService.quoteSelection(selection, {
            trx,
            lock: true,
          });
          const now = clock();
          const expiredBookingIds = [
            ...new Set(
              quote.rows
                .filter(
                  (row) =>
                    row.status === "HELD" &&
                    row.booking_status === "PENDING_PAYMENT" &&
                    row.hold_expires_at &&
                    new Date(row.hold_expires_at) <= now,
                )
                .map((row) => row.booking_id),
            ),
          ];
          if (expiredBookingIds.length) {
            await repository.expireHeldBookings(expiredBookingIds, now, trx);
            quote = await availabilityService.quoteSelection(selection, {
              trx,
            });
          }
          if (!quote.available) {
            throw new AppError(
              409,
              "ROOM_UNAVAILABLE",
              "Không còn đủ phòng cho toàn bộ thời gian đã chọn.",
            );
          }

          const holdExpiresAt = new Date(
            now.getTime() + env.bookingHoldMinutes * 60_000,
          );
          const booking = await repository.insertBooking(
            {
              booking_code: createBookingCode(now),
              user_id: userId,
              room_type_id: selection.roomTypeId,
              check_in: selection.checkIn,
              check_out: selection.checkOut,
              room_quantity: selection.roomQuantity,
              adults: selection.adults,
              children: selection.children,
              contact_full_name: body.contact.fullName.trim(),
              contact_email: body.contact.email.trim().toLowerCase(),
              contact_phone: body.contact.phone.trim(),
              special_requests: body.specialRequests?.trim() || null,
              status: "PENDING_PAYMENT",
              night_count: quote.nightCount,
              subtotal: quote.subtotal,
              discount: 0,
              total_amount: quote.subtotal,
              currency: quote.roomType.currency,
              idempotency_key: key,
              request_fingerprint: requestFingerprint,
              hold_expires_at: holdExpiresAt,
            },
            trx,
          );
          await repository.insertBookingRooms(
            quote.selectedRooms.map((room) => ({
              booking_id: booking.id,
              room_id: room.roomId,
            })),
            trx,
          );
          await repository.insertBookingNights(
            quote.selectedRooms.flatMap((room) =>
              room.nights.map((night) => ({
                booking_id: booking.id,
                room_id: room.roomId,
                stay_date: night.date,
                price: night.price,
              })),
            ),
            trx,
          );
          const heldCount = await repository.holdAvailability(
            booking.id,
            quote.selectedRooms,
            now,
            trx,
          );
          if (heldCount !== selection.roomQuantity * quote.nightCount) {
            throw new AppError(
              409,
              "ROOM_UNAVAILABLE",
              "Inventory đã thay đổi trong lúc đặt phòng.",
            );
          }
          if (body.cartItemId) {
            const deleted = await repository.deleteCartItem(
              body.cartItemId,
              trx,
            );
            if (deleted !== 1)
              throw new AppError(
                409,
                "CART_ITEM_CHANGED",
                "Cart item đã thay đổi.",
              );
          }
          return booking.id;
        });
      } catch (error) {
        if (error.code === "CART_ROOM_TYPE_CHANGED" && resourceRetries < 2) {
          resourceChanged = true;
        } else {
          if (error.code !== "23505") throw error;
          const raced = await repository.findByIdempotency(userId, key);
          if (!raced) throw error;
          assertSameRequest(raced, requestFingerprint);
          bookingId = raced.id;
        }
      } finally {
        await release();
      }
      if (resourceChanged)
        return service.create(userId, key, body, resourceRetries + 1);
      return { booking: await detail(userId, bookingId), reused: false };
    },

    detail,

    async list(userId, filters) {
      const pagination = parsePagination(filters);
      const result = await repository.listOwned(userId, filters, pagination);
      return {
        data: result.rows.map(bookingSummary),
        meta: paginationMeta(pagination.page, pagination.limit, result.total),
      };
    },

    async cancel(userId, bookingId, reason) {
      await db.transaction(async (trx) => {
        const booking = await repository.findOwnedById(
          userId,
          bookingId,
          trx,
          true,
        );
        if (!booking)
          throw new AppError(
            404,
            "BOOKING_NOT_FOUND",
            "Không tìm thấy booking.",
          );
        if (booking.status === "CANCELLED") return;
        if (!["PENDING_PAYMENT", "CONFIRMED"].includes(booking.status)) {
          throw new AppError(
            409,
            "BOOKING_CANNOT_BE_CANCELLED",
            "Booking không thể hủy ở trạng thái hiện tại.",
          );
        }
        if (
          databaseDate(booking.check_in) <=
          todayInTimezone(env.businessTimezone, clock())
        ) {
          throw new AppError(
            409,
            "BOOKING_CANNOT_BE_CANCELLED",
            "Không thể hủy từ ngày check-in.",
          );
        }
        const payments = await repository.getPayments(booking.id, trx);
        if (
          booking.status === "CONFIRMED" ||
          payments.some((payment) => payment.status === "SUCCEEDED")
        ) {
          throw new AppError(
            409,
            "REFUND_NOT_IMPLEMENTED",
            "Booking đã thanh toán cần hoàn tiền thủ công.",
          );
        }
        await repository.lockAvailabilityForBooking(booking.id, trx);
        await repository.releaseAvailability(booking.id, trx);
        await repository.updateStatus(
          booking.id,
          {
            status: "CANCELLED",
            cancelled_at: clock(),
            cancellation_reason: reason?.trim() || null,
          },
          trx,
        );
      });
      return detail(userId, bookingId);
    },
  };
  return service;
}

module.exports = {
  canonicalize,
  createBookingCode,
  createBookingService,
  fingerprint,
  selectionFromCartItem,
};
