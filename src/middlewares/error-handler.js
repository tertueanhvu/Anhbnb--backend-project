const { AppError } = require("../shared/errors/app-error");

function normalizeDatabaseError(error) {
  if (error?.code === "23505") {
    return new AppError(409, "RESOURCE_CONFLICT", "Dữ liệu đã tồn tại.");
  }
  if (error?.code === "23503" || error?.code === "23514") {
    return new AppError(
      409,
      "DATA_CONSTRAINT_VIOLATION",
      "Dữ liệu vi phạm ràng buộc.",
    );
  }
  return error;
}

function errorHandler(error, req, res, _next) {
  const normalized = normalizeDatabaseError(error);
  const expected = normalized instanceof AppError;
  const status = expected ? normalized.status : 500;
  const code = expected ? normalized.code : "INTERNAL_ERROR";
  const message = expected ? normalized.message : "Đã xảy ra lỗi hệ thống.";

  if (!expected) {
    req.log?.error(
      { err: normalized, requestId: req.id },
      "Unhandled request error",
    );
  }

  res.status(status).json({
    error: {
      code,
      message,
      details: expected ? normalized.details : [],
      requestId: req.id,
    },
  });
}

module.exports = { errorHandler, normalizeDatabaseError };
