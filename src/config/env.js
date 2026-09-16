const dotenv = require("dotenv");
const Joi = require("joi");

dotenv.config({ quiet: true });

let cachedEnv;

const schema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  TEST_DATABASE_URL: Joi.string()
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
    databaseUrl: value.DATABASE_URL,
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
