const jwt = require("jsonwebtoken");
const { AppError } = require("../shared/errors/app-error");

function createAuthenticate({ repository, env }) {
  return async function authenticate(req, _res, next) {
    try {
      const authorization = req.get("Authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match)
        throw new AppError(401, "UNAUTHORIZED", "Thiếu Bearer token hợp lệ.");
      const payload = jwt.verify(match[1], env.jwtSecret, {
        algorithms: ["HS256"],
      });
      if (!payload?.id || !payload?.email) {
        throw new AppError(401, "UNAUTHORIZED", "Token không hợp lệ.");
      }
      const user = await repository.findActiveById(payload.id);
      if (!user)
        throw new AppError(
          401,
          "UNAUTHORIZED",
          "Tài khoản không còn hoạt động.",
        );
      req.auth = { id: user.id, email: user.email };
      return next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      return next(
        new AppError(
          401,
          "UNAUTHORIZED",
          "Token không hợp lệ hoặc đã hết hạn.",
        ),
      );
    }
  };
}

module.exports = { createAuthenticate };
