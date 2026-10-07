const { createHmac } = require("node:crypto");
const { ipKeyGenerator } = require("express-rate-limit");
const { AppError } = require("../shared/errors/app-error");
const { createRateLimitStore } = require("../infrastructure/redis/rate-limit");

function createRateLimiters({ redis, env, metrics }) {
  const store = createRateLimitStore({
    redis,
    namespace: env.redisNamespace,
    metrics,
  });
  const hash = (value) =>
    createHmac("sha256", env.rateLimitKeySecret).update(value).digest("hex");
  const ip = (req) =>
    ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown", 64);
  const account = (req) =>
    typeof req.body?.email === "string"
      ? req.body.email.trim().normalize("NFC").toLowerCase().slice(0, 320)
      : null;
  const user = (req) => req.auth?.id;
  const options = env.rateLimit;

  function limiter(rules) {
    return async (req, res, next) => {
      try {
        for (const [policy, identify, limit, windowMs] of rules) {
          const subject = identify(req);
          if (!subject) continue;
          const result = await store.hit(policy, hash(subject), windowMs);
          res.set("RateLimit-Limit", String(limit));
          res.set(
            "RateLimit-Remaining",
            String(Math.max(0, limit - result.count)),
          );
          res.set("RateLimit-Reset", String(result.retryAfter));
          if (result.count > limit) {
            metrics?.increment(`rate_limit.denied.${policy}`);
            res.set("Retry-After", String(result.retryAfter));
            throw new AppError(
              429,
              "RATE_LIMITED",
              "Quá nhiều yêu cầu, vui lòng thử lại sau.",
            );
          }
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }
  const command = (name) =>
    limiter([
      [`${name}-ip`, ip, options.commandIp, options.commandWindowMs],
      [`${name}-user`, user, options.commandUser, options.commandWindowMs],
    ]);
  return {
    login: limiter([
      ["login-ip", ip, options.loginIp, options.authWindowMs],
      ["login-account", account, options.loginAccount, options.authWindowMs],
    ]),
    register: limiter([
      ["register-ip", ip, options.registerIp, options.authWindowMs],
    ]),
    search: limiter([
      ["search-ip", ip, options.search, options.searchWindowMs],
      ["search-user", user, options.search, options.searchWindowMs],
    ]),
    booking: command("booking"),
    payment: command("payment"),
    async meterWebhook(appId) {
      const result = await store.hit("webhook-app", hash(String(appId)), 60000);
      if (result.count > options.webhookSoft)
        metrics?.increment("webhook.soft_limit_exceeded");
    },
  };
}

module.exports = { createRateLimiters };
