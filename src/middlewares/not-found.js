const { AppError } = require("../shared/errors/app-error");

function notFound(req, _res, next) {
  next(
    new AppError(
      404,
      "NOT_FOUND",
      `Không tìm thấy ${req.method} ${req.originalUrl}.`,
    ),
  );
}

module.exports = { notFound };
