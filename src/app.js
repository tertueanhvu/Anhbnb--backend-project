const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const { getEnv } = require("./config/env");
const { JSON_BODY_LIMIT } = require("./config/constants");
const { requestId } = require("./middlewares/request-id");
const { notFound } = require("./middlewares/not-found");
const { errorHandler } = require("./middlewares/error-handler");
const { AppError } = require("./shared/errors/app-error");
const { asyncHandler } = require("./shared/http/async-handler");
const { logger } = require("./shared/security/logger");
const { createApiRouter } = require("./routes");

function createApp({
  checkDatabase = async () => true,
  apiRouter = createApiRouter(),
} = {}) {
  const env = getEnv();
  const app = express();
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === "/health/live" },
    }),
  );
  app.use(helmet({ hsts: env.nodeEnv === "production" ? undefined : false }));
  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          !env.corsOrigins.length ||
          env.corsOrigins.includes(origin)
        ) {
          return callback(null, true);
        }
        return callback(
          new AppError(403, "CORS_ORIGIN_DENIED", "Origin không được phép."),
        );
      },
    }),
  );
  app.use((req, _res, next) => {
    if (env.nodeEnv === "production" && !req.secure) {
      return next(new AppError(400, "HTTPS_REQUIRED", "HTTPS là bắt buộc."));
    }
    return next();
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get("/health/live", (_req, res) => res.json({ data: { status: "ok" } }));
  app.get(
    "/health/ready",
    asyncHandler(async (_req, res) => {
      try {
        await checkDatabase();
        res.json({ data: { status: "ready" } });
      } catch {
        res.status(503).json({
          error: { code: "NOT_READY", message: "Dependency chưa sẵn sàng." },
        });
      }
    }),
  );

  if (apiRouter) app.use("/api/v1", apiRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
