const express = require("express");
const { db } = require("./db/postgres");
const { getEnv } = require("./config/env");
const { createAuthRepository } = require("./modules/auth/auth.repository");
const { createAuthService } = require("./modules/auth/auth.service");
const { createAuthController } = require("./modules/auth/auth.controller");
const { createAuthRouter } = require("./modules/auth/auth.routes");
const { createAuthenticate } = require("./middlewares/authenticate");
const {
  createAvailabilityRepository,
} = require("./modules/availability/availability.repository");
const {
  createAvailabilityService,
} = require("./modules/availability/availability.service");
const {
  createAvailabilityController,
} = require("./modules/availability/availability.controller");
const {
  createPropertyRepository,
} = require("./modules/properties/property.repository");
const {
  createPropertyService,
} = require("./modules/properties/property.service");
const {
  createPropertyController,
} = require("./modules/properties/property.controller");
const {
  createPropertyRouter,
} = require("./modules/properties/property.routes");
const { createCartRepository } = require("./modules/carts/cart.repository");
const { createCartService } = require("./modules/carts/cart.service");
const { createCartController } = require("./modules/carts/cart.controller");
const { createCartRouter } = require("./modules/carts/cart.routes");
const {
  createBookingRepository,
} = require("./modules/bookings/booking.repository");
const { createBookingService } = require("./modules/bookings/booking.service");
const {
  createBookingController,
} = require("./modules/bookings/booking.controller");
const { createBookingRouter } = require("./modules/bookings/booking.routes");
const {
  createPaymentRepository,
} = require("./modules/payments/payment.repository");
const { createPaymentService } = require("./modules/payments/payment.service");
const {
  createPaymentController,
} = require("./modules/payments/payment.controller");
const { createPaymentRouter } = require("./modules/payments/payment.routes");
const {
  createZaloPayProvider,
} = require("./modules/payments/providers/zalopay.provider");
const {
  createMockPaymentProvider,
} = require("./modules/payments/providers/mock-payment.provider");

function createApiRouter() {
  const env = getEnv();
  const router = express.Router();
  const authRepository = createAuthRepository(db);
  const authService = createAuthService({ repository: authRepository, env });
  const authController = createAuthController(authService);
  const authenticate = createAuthenticate({ repository: authRepository, env });
  const availabilityRepository = createAvailabilityRepository(db);
  const availabilityService = createAvailabilityService({
    repository: availabilityRepository,
    env,
  });
  const availabilityController =
    createAvailabilityController(availabilityService);
  const propertyRepository = createPropertyRepository(db);
  const propertyService = createPropertyService({
    repository: propertyRepository,
    availabilityService,
  });
  const propertyController = createPropertyController(propertyService);
  const cartRepository = createCartRepository(db);
  const cartService = createCartService({
    repository: cartRepository,
    availabilityService,
    db,
  });
  const cartController = createCartController(cartService);
  const bookingRepository = createBookingRepository(db);
  const bookingService = createBookingService({
    db,
    repository: bookingRepository,
    availabilityService,
    env,
  });
  const bookingController = createBookingController(bookingService);
  const provider =
    env.paymentProviderMode === "zalopay"
      ? createZaloPayProvider(env.zalopay)
      : createMockPaymentProvider({
          key2: env.zalopay.key2 || "mock-callback-key",
        });
  const paymentRepository = createPaymentRepository(db);
  const paymentService = createPaymentService({
    db,
    repository: paymentRepository,
    bookingRepository,
    provider,
    env,
  });
  const paymentController = createPaymentController(paymentService);

  router.use(createAuthRouter({ controller: authController, authenticate }));
  router.use(
    createPropertyRouter({
      controller: propertyController,
      availabilityController,
    }),
  );
  router.use(createCartRouter({ controller: cartController, authenticate }));
  router.use(
    createBookingRouter({ controller: bookingController, authenticate }),
  );
  router.use(
    createPaymentRouter({ controller: paymentController, authenticate }),
  );
  router.runtimeServices = { availabilityService, paymentService };
  return router;
}

module.exports = { createApiRouter };
