const pino = require("pino");

const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "*.password",
      "accessToken",
      "*.accessToken",
      "mac",
      "*.mac",
      "key1",
      "key2",
    ],
    censor: "[REDACTED]",
  },
});

module.exports = { logger };
