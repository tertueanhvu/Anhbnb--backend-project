const express = require("express");
const { db } = require("./db/postgres");
const { getEnv } = require("./config/env");
const { createMetrics } = require("./infrastructure/metrics");
const { createDomainServices } = require("./runtime/domain-services");
const {
  createBulkQuoteRepository,
} = require("./modules/availability/bulk-quote.repository");
const {
  createBulkQuoteService,
} = require("./modules/availability/bulk-quote.service");
const { createSearchClient } = require("./infrastructure/search/client");
const {
  createSearchRepository,
} = require("./modules/search/search.repository");
const { createFreshnessGate } = require("./modules/search/freshness");
const { createSearchCursor } = require("./modules/search/cursor");
const { createRedisClient } = require("./infrastructure/redis/client");
const { createBookingLock } = require("./infrastructure/redis/lock");
const { createRateLimiters } = require("./middlewares/rate-limit");
const { createPublicCache } = require("./infrastructure/redis/cache");
const {
  createReferenceRepository,
} = require("./modules/catalog/reference.repository");
const {
  createReferenceService,
} = require("./modules/catalog/reference.service");
const { createReferenceRouter } = require("./modules/catalog/reference.routes");
const { createAuthRepository } = require("./modules/auth/auth.repository");
const { createAuthService } = require("./modules/auth/auth.service");
const { createAuthController } = require("./modules/auth/auth.controller");
const { createAuthRouter } = require("./modules/auth/auth.routes");
const { createAuthenticate } = require("./middlewares/authenticate");
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
  createBookingController,
} = require("./modules/bookings/booking.controller");
const { createBookingRouter } = require("./modules/bookings/booking.routes");
const {
  createPaymentController,
} = require("./modules/payments/payment.controller");
const { createPaymentRouter } = require("./modules/payments/payment.routes");

function createApiRouter({ env = getEnv() } = {}) {
  const router = express.Router();
  const metrics = createMetrics();
  const redis = createRedisClient({
    url: env.redisUrl,
    commandTimeoutMs: env.redisCommandTimeoutMs,
    metrics,
  });
  const limiters = createRateLimiters({ redis, env, metrics });
  const bookingLock = createBookingLock({
    redis,
    namespace: env.redisNamespace,
    ttlMs: env.redisLockTtlMs,
    retryCount: env.redisLockRetryCount,
    waitMs: env.redisLockWaitMs,
    metrics,
  });
  const cache = createPublicCache({
    redis,
    namespace: env.redisNamespace,
    enabled: env.cacheEnabled,
    metrics,
  });
  const authRepository = createAuthRepository(db);
  const authService = createAuthService({ repository: authRepository, env });
  const authController = createAuthController(authService);
  const authenticate = createAuthenticate({ repository: authRepository, env });
  const { availabilityService, bookingService, paymentService } =
    createDomainServices({
      db,
      env,
      bookingLock,
      meterWebhook: limiters.meterWebhook,
    });
  const availabilityController =
    createAvailabilityController(availabilityService);
  const propertyRepository = createPropertyRepository(db);
  const propertyService = createPropertyService({
    repository: propertyRepository,
    availabilityService,
    bulkQuoteService: createBulkQuoteService({
      repository: createBulkQuoteRepository(db),
      env,
    }),
    search:
      env.searchBackend === "es"
        ? {
            repository: createSearchRepository({
              client: createSearchClient({
                url: env.elasticsearchUrl,
                apiKey: env.elasticsearchApiKey,
              }),
              index: env.elasticsearchIndex,
              metrics,
            }),
            freshness: createFreshnessGate({
              db,
              topic: `${env.kafkaTopicPrefix}.catalog.events.v1`,
              maxAgeMs: env.searchFreshnessMaxAgeMs,
            }),
            cursor: createSearchCursor(env.jwtSecret),
          }
        : null,
    cache,
    cacheTtl: env.cacheTtl,
  });
  const propertyController = createPropertyController(propertyService);
  const cartRepository = createCartRepository(db);
  const cartService = createCartService({
    repository: cartRepository,
    availabilityService,
    db,
  });
  const cartController = createCartController(cartService);
  const bookingController = createBookingController(bookingService);
  const paymentController = createPaymentController(paymentService);

  router.use(
    createAuthRouter({ controller: authController, authenticate, limiters }),
  );
  const referenceService = createReferenceService({
    repository: createReferenceRepository(db),
    cache,
    ttlSeconds: env.cacheTtl.reference,
  });
  router.use(
    createReferenceRouter({
      service: referenceService,
      authenticate,
      limiters,
    }),
  );
  router.use(
    createPropertyRouter({
      controller: propertyController,
      availabilityController,
      authenticate,
      limiters,
    }),
  );
  router.use(createCartRouter({ controller: cartController, authenticate }));
  router.use(
    createBookingRouter({
      controller: bookingController,
      authenticate,
      limiters,
    }),
  );
  router.use(
    createPaymentRouter({
      controller: paymentController,
      authenticate,
      limiters,
      webhookMaxConcurrent: env.webhookMaxConcurrent,
    }),
  );
  router.runtimeServices = {
    availabilityService,
    paymentService,
    redis,
    cache,
    metrics,
  };
  router.close = () => redis.close();
  return router;
}

module.exports = { createApiRouter };
