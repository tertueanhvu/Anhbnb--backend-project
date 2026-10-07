const dotenv = require("dotenv");
const Joi = require("joi");

dotenv.config({ path: process.env.ENV_FILE || ".env", quiet: true });

let cachedEnv;

const schema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  PORT: Joi.number().port().default(3000),
  OUTBOX_ENABLED: Joi.boolean().default(false),
  KAFKA_BROKERS: Joi.string().default("localhost:9092"),
  KAFKA_CONNECT_URL: Joi.string().uri().default("http://localhost:8083"),
  KAFKA_TOPIC_PREFIX: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .default("anhbnb"),
  KAFKA_GROUP_PREFIX: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .default("anhbnb"),
  WORKER_HANDLERS: Joi.string()
    .pattern(/^(notification|cache|search)(,(notification|cache|search))*$/)
    .default("notification,cache"),
  SEARCH_BACKEND: Joi.string().valid("pg", "es").default("pg"),
  ELASTICSEARCH_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .default("http://localhost:9200"),
  ELASTICSEARCH_API_KEY: Joi.string().allow("").default(""),
  ELASTICSEARCH_INDEX: Joi.string()
    .pattern(/^[a-z][a-z0-9_-]{0,150}$/)
    .default("properties_read"),
  SEARCH_PROBES_ENABLED: Joi.boolean().default(false),
  SEARCH_FRESHNESS_MAX_AGE_MS: Joi.number()
    .integer()
    .min(15000)
    .max(60000)
    .default(60000),
  EMAIL_TRANSPORT: Joi.string().valid("log").default("log"),
  CONSUMER_RETRY_MAX: Joi.number().integer().min(0).max(5).default(5),
  NOTIFICATION_POLL_MS: Joi.number().integer().min(100).default(1000),
  TRUST_PROXY: Joi.string().default("false"),
  REDIS_URL: Joi.string()
    .uri({ scheme: ["redis", "rediss"] })
    .allow("")
    .default(""),
  REDIS_NAMESPACE: Joi.string()
    .pattern(/^[a-zA-Z0-9:_-]+$/)
    .default("anhbnb:dev"),
  REDIS_COMMAND_TIMEOUT_MS: Joi.number()
    .integer()
    .min(10)
    .max(2000)
    .default(100),
  REDIS_LOCK_TTL_MS: Joi.number().integer().min(1000).default(10000),
  REDIS_LOCK_RETRY_COUNT: Joi.number().integer().min(0).max(10).default(3),
  REDIS_LOCK_WAIT_MS: Joi.number().integer().min(0).max(5000).default(500),
  RATE_LIMIT_KEY_SECRET: Joi.string().min(32).optional(),
  RATE_LIMIT_AUTH_WINDOW_MS: Joi.number().integer().min(1000).default(900000),
  RATE_LIMIT_LOGIN_IP: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_LOGIN_ACCOUNT: Joi.number().integer().min(1).default(10),
  RATE_LIMIT_REGISTER_IP: Joi.number().integer().min(1).default(5),
  RATE_LIMIT_SEARCH_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_SEARCH: Joi.number().integer().min(1).default(120),
  RATE_LIMIT_COMMAND_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_COMMAND_USER: Joi.number().integer().min(1).default(10),
  RATE_LIMIT_COMMAND_IP: Joi.number().integer().min(1).default(60),
  RATE_LIMIT_WEBHOOK_SOFT: Joi.number().integer().min(1).default(600),
  WEBHOOK_MAX_CONCURRENT: Joi.number().integer().min(1).default(16),
  CACHE_ENABLED: Joi.boolean().default(true),
  CACHE_PROPERTY_TTL_SECONDS: Joi.number().integer().min(1).default(300),
  CACHE_REFERENCE_TTL_SECONDS: Joi.number().integer().min(1).default(3600),
  CACHE_SEARCH_TTL_SECONDS: Joi.number().integer().min(1).default(30),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  TEST_DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .optional(),
  MIGRATION_DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .optional(),
  TEST_MIGRATION_DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .optional(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default("1d"),
  BUSINESS_TIMEZONE: Joi.string().default("Asia/Ho_Chi_Minh"),
  BOOKING_HOLD_MINUTES: Joi.number().integer().min(1).default(15),
  RECONCILE_INTERVAL_MS: Joi.number().integer().min(1000).default(30000),
  PAYMENT_RECONCILE_GRACE_MS: Joi.number().integer().min(0).default(60000),
  BACKGROUND_JOBS_ENABLED: Joi.boolean()
    .truthy("true")
    .falsy("false")
    .default(true),
  AVAILABILITY_WINDOW_DAYS: Joi.number().integer().min(1).max(730).default(365),
  MAX_STAY_NIGHTS: Joi.number().integer().min(1).max(365).default(365),
  CORS_ORIGINS: Joi.string().allow("").default(""),
  PAYMENT_PROVIDER_MODE: Joi.string().valid("mock", "zalopay").default("mock"),
  ZALOPAY_APP_ID: Joi.string().allow("").default(""),
  ZALOPAY_KEY1: Joi.string().allow("").default(""),
  ZALOPAY_KEY2: Joi.string().allow("").default(""),
  ZALOPAY_CREATE_ORDER_URL: Joi.when("PAYMENT_PROVIDER_MODE", {
    is: "zalopay",
    then: Joi.string().uri().required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  ZALOPAY_QUERY_ORDER_URL: Joi.when("PAYMENT_PROVIDER_MODE", {
    is: "zalopay",
    then: Joi.string().uri().required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  ZALOPAY_CALLBACK_URL: Joi.when("PAYMENT_PROVIDER_MODE", {
    is: "zalopay",
    then: Joi.string().uri().required(),
    otherwise: Joi.string().allow("").default(""),
  }),
}).unknown(true);

function getEnv() {
  if (cachedEnv) return cachedEnv;

  const source = {
    ...process.env,
    DATABASE_URL:
      process.env.NODE_ENV === "test" && process.env.TEST_DATABASE_URL
        ? process.env.TEST_DATABASE_URL
        : process.env.DATABASE_URL,
  };
  const { value, error } = schema.validate(source, { abortEarly: false });
  if (error) {
    throw new Error(`Invalid environment configuration: ${error.message}`);
  }

  if (
    value.NODE_ENV === "production" &&
    value.PAYMENT_PROVIDER_MODE === "zalopay"
  ) {
    const required = [
      "ZALOPAY_APP_ID",
      "ZALOPAY_KEY1",
      "ZALOPAY_KEY2",
      "ZALOPAY_CREATE_ORDER_URL",
      "ZALOPAY_QUERY_ORDER_URL",
      "ZALOPAY_CALLBACK_URL",
    ];
    const missing = required.filter((key) => !value[key]);
    if (missing.length)
      throw new Error(`Missing ZaloPay configuration: ${missing.join(", ")}`);
  }

  cachedEnv = Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    outboxEnabled: value.OUTBOX_ENABLED,
    kafkaBrokers: value.KAFKA_BROKERS.split(",").map((item) => item.trim()),
    kafkaConnectUrl: value.KAFKA_CONNECT_URL,
    kafkaTopicPrefix: value.KAFKA_TOPIC_PREFIX,
    kafkaGroupPrefix: value.KAFKA_GROUP_PREFIX,
    workerHandlers: [...new Set(value.WORKER_HANDLERS.split(","))],
    searchBackend: value.SEARCH_BACKEND,
    elasticsearchUrl: value.ELASTICSEARCH_URL,
    elasticsearchApiKey: value.ELASTICSEARCH_API_KEY,
    elasticsearchIndex: value.ELASTICSEARCH_INDEX,
    searchProbesEnabled: value.SEARCH_PROBES_ENABLED,
    searchFreshnessMaxAgeMs: value.SEARCH_FRESHNESS_MAX_AGE_MS,
    emailTransport: value.EMAIL_TRANSPORT,
    consumerRetryMax: value.CONSUMER_RETRY_MAX,
    notificationPollMs: value.NOTIFICATION_POLL_MS,
    trustProxy:
      value.TRUST_PROXY === "false"
        ? false
        : value.TRUST_PROXY.split(",").map((item) => item.trim()),
    redisUrl: value.REDIS_URL,
    redisNamespace:
      value.NODE_ENV === "test"
        ? `${value.REDIS_NAMESPACE}:test`
        : value.REDIS_NAMESPACE,
    redisCommandTimeoutMs: value.REDIS_COMMAND_TIMEOUT_MS,
    redisLockTtlMs: value.REDIS_LOCK_TTL_MS,
    redisLockRetryCount: value.REDIS_LOCK_RETRY_COUNT,
    redisLockWaitMs: value.REDIS_LOCK_WAIT_MS,
    rateLimitKeySecret: value.RATE_LIMIT_KEY_SECRET || value.JWT_SECRET,
    rateLimit: {
      authWindowMs: value.RATE_LIMIT_AUTH_WINDOW_MS,
      loginIp: value.RATE_LIMIT_LOGIN_IP,
      loginAccount: value.RATE_LIMIT_LOGIN_ACCOUNT,
      registerIp: value.RATE_LIMIT_REGISTER_IP,
      searchWindowMs: value.RATE_LIMIT_SEARCH_WINDOW_MS,
      search: value.RATE_LIMIT_SEARCH,
      commandWindowMs: value.RATE_LIMIT_COMMAND_WINDOW_MS,
      commandUser: value.RATE_LIMIT_COMMAND_USER,
      commandIp: value.RATE_LIMIT_COMMAND_IP,
      webhookSoft: value.RATE_LIMIT_WEBHOOK_SOFT,
    },
    webhookMaxConcurrent: value.WEBHOOK_MAX_CONCURRENT,
    cacheEnabled: value.CACHE_ENABLED,
    cacheTtl: {
      property: value.CACHE_PROPERTY_TTL_SECONDS,
      reference: value.CACHE_REFERENCE_TTL_SECONDS,
      search: value.CACHE_SEARCH_TTL_SECONDS,
    },
    databaseUrl: value.DATABASE_URL,
    migrationDatabaseUrl:
      value.NODE_ENV === "test"
        ? value.TEST_MIGRATION_DATABASE_URL || value.DATABASE_URL
        : value.MIGRATION_DATABASE_URL || value.DATABASE_URL,
    jwtSecret: value.JWT_SECRET,
    jwtExpiresIn: value.JWT_EXPIRES_IN,
    businessTimezone: value.BUSINESS_TIMEZONE,
    bookingHoldMinutes: value.BOOKING_HOLD_MINUTES,
    reconcileIntervalMs: value.RECONCILE_INTERVAL_MS,
    paymentReconcileGraceMs: value.PAYMENT_RECONCILE_GRACE_MS,
    backgroundJobsEnabled: value.BACKGROUND_JOBS_ENABLED,
    availabilityWindowDays: value.AVAILABILITY_WINDOW_DAYS,
    maxStayNights: value.MAX_STAY_NIGHTS,
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    paymentProviderMode: value.PAYMENT_PROVIDER_MODE,
    zalopay: {
      appId: value.ZALOPAY_APP_ID,
      key1: value.ZALOPAY_KEY1,
      key2: value.ZALOPAY_KEY2,
      createOrderUrl: value.ZALOPAY_CREATE_ORDER_URL,
      queryOrderUrl: value.ZALOPAY_QUERY_ORDER_URL,
      callbackUrl: value.ZALOPAY_CALLBACK_URL,
    },
  });
  return cachedEnv;
}

function resetEnvForTests() {
  cachedEnv = undefined;
}

module.exports = { getEnv, resetEnvForTests };
