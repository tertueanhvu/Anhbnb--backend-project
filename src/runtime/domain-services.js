const {
  createOutboxRepository,
} = require("../modules/events/outbox.repository");
const {
  createAvailabilityRepository,
} = require("../modules/availability/availability.repository");
const {
  createAvailabilityService,
} = require("../modules/availability/availability.service");
const {
  createBookingRepository,
} = require("../modules/bookings/booking.repository");
const { createBookingService } = require("../modules/bookings/booking.service");
const {
  createPaymentRepository,
} = require("../modules/payments/payment.repository");
const { createPaymentService } = require("../modules/payments/payment.service");
const {
  createMockPaymentProvider,
} = require("../modules/payments/providers/mock-payment.provider");
const {
  createZaloPayProvider,
} = require("../modules/payments/providers/zalopay.provider");

// Shared composition without creating an HTTP router/server.
function createDomainServices({ db, env, bookingLock, meterWebhook }) {
  const outbox = env.outboxEnabled ? createOutboxRepository() : null;
  const bookingRepository = createBookingRepository(db, { outbox });
  const availabilityService = createAvailabilityService({
    repository: createAvailabilityRepository(db),
    env,
  });
  const bookingService = createBookingService({
    db,
    repository: bookingRepository,
    availabilityService,
    env,
    bookingLock,
  });
  const provider =
    env.paymentProviderMode === "zalopay"
      ? createZaloPayProvider(env.zalopay)
      : createMockPaymentProvider({
          key2: env.zalopay.key2 || "mock-callback-key",
        });
  const paymentService = createPaymentService({
    db,
    repository: createPaymentRepository(db, { outbox }),
    bookingRepository,
    provider,
    env,
    meterWebhook,
  });
  return { availabilityService, bookingService, paymentService };
}
module.exports = { createDomainServices };
