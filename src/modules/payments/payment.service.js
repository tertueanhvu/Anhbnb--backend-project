const { AppError } = require("../../shared/errors/app-error");
const { todayInTimezone } = require("../../shared/dates");

function paymentDto(payment) {
  return {
    id: payment.id,
    bookingId: payment.booking_id,
    provider: payment.provider,
    status: payment.status,
    amount: Number(payment.amount),
    currency: payment.currency,
    checkoutUrl: payment.checkout_url,
    expiresAt: payment.expires_at,
    paidAt: payment.paid_at,
  };
}

function appTransId(now, bookingCode, attempt, timezone = "Asia/Ho_Chi_Minh") {
  const prefix = todayInTimezone(timezone, now).slice(2).replaceAll("-", "");
  return `${prefix}_${bookingCode}_${attempt}`.slice(0, 40);
}

function createPaymentService({
  db,
  repository,
  bookingRepository,
  provider,
  env,
  meterWebhook = async () => {},
  clock = () => new Date(),
}) {
  async function applySuccess(event) {
    return db.transaction(async (trx) => {
      const payment = event.paymentId
        ? await repository.findById(event.paymentId, trx, true)
        : await repository.findByAppTransId(event.appTransId, trx, true);
      if (!payment)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Không tìm thấy payment.");
      if (payment.status === "SUCCEEDED")
        return { payment, duplicate: true, manualRefundRequired: false };
      if (String(event.appId) !== String(provider.appId)) {
        throw new AppError(
          409,
          "PAYMENT_APP_MISMATCH",
          "Payment app ID không khớp.",
        );
      }
      if (Number(event.amount) !== Number(payment.amount)) {
        throw new AppError(
          409,
          "PAYMENT_AMOUNT_MISMATCH",
          "Payment amount không khớp.",
        );
      }

      const booking = await repository.findBookingById(
        payment.booking_id,
        trx,
        true,
      );
      const allocation = await repository.lockBookingAllocation(
        booking.id,
        trx,
      );
      const now = clock();
      let canConfirm = booking.status === "PENDING_PAYMENT";
      let late = false;
      if (
        canConfirm &&
        booking.hold_expires_at &&
        new Date(booking.hold_expires_at) < now
      )
        late = true;
      if (booking.status === "EXPIRED") {
        canConfirm = true;
        late = true;
      }

      if (canConfirm && !late) {
        const booked = await repository.bookHeldAvailability(
          booking.id,
          now,
          trx,
        );
        if (booked !== allocation.length) {
          throw new AppError(
            409,
            "PAYMENT_ALLOCATION_MISMATCH",
            "Các dòng phòng giữ chỗ không còn đầy đủ.",
          );
        }
        await repository.confirmBooking(booking.id, now, trx);
      } else if (canConfirm && late) {
        const reclaimable =
          allocation.length > 0 &&
          allocation.every(
            (row) =>
              row.booking_id === booking.id ||
              (row.status === "OPEN" && row.booking_id === null),
          );
        if (reclaimable) {
          const reclaimed = await repository.reclaimAllocation(
            booking.id,
            allocation,
            now,
            trx,
          );
          if (reclaimed !== allocation.length) {
            throw new AppError(
              409,
              "PAYMENT_ALLOCATION_MISMATCH",
              "Không thể giành lại đầy đủ phòng.",
            );
          }
          await repository.confirmBooking(booking.id, now, trx);
        }
      }

      const updated = await repository.markSucceeded(
        payment.id,
        String(event.providerTransId),
        event.paidAt || now,
        trx,
      );
      const finalBooking = await repository.findBookingById(booking.id, trx);
      return {
        payment: updated,
        duplicate: false,
        manualRefundRequired: finalBooking.status !== "CONFIRMED",
      };
    });
  }

  async function applyFailure(paymentId, event) {
    await db.transaction(async (trx) => {
      const payment = await repository.findById(paymentId, trx, true);
      if (!payment || payment.status === "SUCCEEDED") return;
      await repository.markFailed(
        payment.id,
        event.providerCode,
        "Provider xác nhận thất bại.",
        trx,
      );
    });
  }

  return {
    async create(userId, bookingId) {
      const now = clock();
      const prepared = await db.transaction(async (trx) => {
        const booking = await repository.findOwnedBookingForUpdate(
          userId,
          bookingId,
          trx,
        );
        if (!booking)
          throw new AppError(
            404,
            "BOOKING_NOT_FOUND",
            "Không tìm thấy booking.",
          );
        if (booking.status !== "PENDING_PAYMENT") {
          throw new AppError(
            409,
            "BOOKING_NOT_PAYABLE",
            "Booking không ở trạng thái chờ thanh toán.",
          );
        }
        if (new Date(booking.hold_expires_at) <= now) {
          await bookingRepository.lockAvailabilityForBooking(booking.id, trx);
          await bookingRepository.expireHeldBookings([booking.id], now, trx);
          return { expired: true };
        }
        const reusable = await repository.findReusableAttempt(
          booking.id,
          now,
          trx,
        );
        if (reusable) return { payment: reusable, booking, reused: true };
        const attempt = await repository.nextAttemptNumber(booking.id, trx);
        const expiresAt = new Date(
          Math.min(
            new Date(booking.hold_expires_at).getTime(),
            now.getTime() + 15 * 60_000,
          ),
        );
        const payment = await repository.create(
          {
            booking_id: booking.id,
            provider: "ZALOPAY",
            attempt_number: attempt,
            app_trans_id: appTransId(
              now,
              booking.booking_code,
              attempt,
              env.businessTimezone,
            ),
            amount: booking.total_amount,
            currency: booking.currency,
            status: "CREATED",
            expires_at: expiresAt,
          },
          trx,
        );
        return { payment, booking, reused: false };
      });

      if (prepared.expired) {
        throw new AppError(
          409,
          "BOOKING_HOLD_EXPIRED",
          "Thời gian giữ phòng đã hết.",
        );
      }

      if (prepared.reused && prepared.payment.checkout_url) {
        return { payment: paymentDto(prepared.payment), reused: true };
      }
      try {
        const providerResult = await provider.createOrder({
          paymentId: prepared.payment.id,
          bookingId: prepared.booking.id,
          bookingCode: prepared.booking.booking_code,
          userId,
          appTransId: prepared.payment.app_trans_id,
          amount: Number(prepared.payment.amount),
        });
        const updated = await repository.updateIfNotSucceeded(
          prepared.payment.id,
          {
            status: "PENDING",
            checkout_url: providerResult.checkoutUrl,
            provider_code: providerResult.providerCode,
            provider_message: providerResult.providerMessage,
          },
        );
        return { payment: paymentDto(updated), reused: prepared.reused };
      } catch (error) {
        await repository.updateIfNotSucceeded(prepared.payment.id, {
          status: error.definitive ? "FAILED" : "PENDING",
          provider_code: error.providerCode || "PROVIDER_ERROR",
          provider_message: error.message.slice(0, 500),
        });
        throw error;
      }
    },

    async callback(body) {
      const data = provider.verifyCallback(body);
      if (String(data.app_id) === String(provider.appId)) {
        // Telemetry is after MAC verification and must not block valid callbacks.
        await meterWebhook(data.app_id).catch(() => {});
      }
      const result = await applySuccess({
        appId: data.app_id,
        appTransId: data.app_trans_id,
        amount: data.amount,
        providerTransId: data.zp_trans_id,
        paidAt: data.server_time ? new Date(Number(data.server_time)) : clock(),
      });
      return result;
    },

    async get(userId, paymentId) {
      const payment = await repository.findOwnedById(userId, paymentId);
      if (!payment)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Không tìm thấy payment.");
      return paymentDto(payment);
    },

    async reconcile(userId, paymentId) {
      const owned = await repository.findOwnedById(userId, paymentId);
      if (!owned)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Không tìm thấy payment.");
      if (owned.status === "SUCCEEDED") return paymentDto(owned);
      const event = await provider.queryOrder(owned.app_trans_id);
      if (event.status === "SUCCEEDED") {
        const result = await applySuccess({
          ...event,
          paymentId: owned.id,
          appId: event.appId || provider.appId,
        });
        return paymentDto(result.payment);
      }
      if (event.status === "FAILED") await applyFailure(owned.id, event);
      return paymentDto(await repository.findById(owned.id));
    },

    async reconcileExpiredBatch(limit = 50) {
      const now = clock();
      const due = await repository.duePendingBookings(now, limit);
      for (const { id, hold_expires_at: holdExpiresAt } of due) {
        const attempt = await repository.latestAttempt(id);
        if (attempt && ["CREATED", "PENDING"].includes(attempt.status)) {
          try {
            const event = await provider.queryOrder(attempt.app_trans_id);
            if (event.status === "SUCCEEDED") {
              await applySuccess({
                ...event,
                paymentId: attempt.id,
                appId: event.appId || provider.appId,
              });
              continue;
            }
            if (
              event.status === "PENDING" &&
              now.getTime() - new Date(holdExpiresAt).getTime() <=
                env.paymentReconcileGraceMs
            ) {
              continue;
            }
          } catch {
            continue;
          }
        }
        await db.transaction(async (trx) => {
          await bookingRepository.lockAvailabilityForBooking(id, trx);
          await bookingRepository.expireHeldBookings([id], now, trx);
        });
      }
      return {
        checked: due.length,
        mismatches: await repository.integrityMismatches(),
      };
    },

    async integrityReport() {
      return repository.integrityMismatches();
    },

    applySuccess,
    paymentDto,
  };
}

module.exports = { appTransId, createPaymentService, paymentDto };
