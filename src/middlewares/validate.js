const { AppError } = require("../shared/errors/app-error");

function validate(schemas) {
  return function validationMiddleware(req, _res, next) {
    const details = [];
    for (const key of ["params", "query", "body", "headers"]) {
      if (!schemas[key]) continue;
      const { value, error } = schemas[key].validate(req[key], {
        abortEarly: false,
        allowUnknown: key === "headers",
        stripUnknown: false,
      });
      if (error) {
        details.push(
          ...error.details.map((item) => ({
            field: item.path.join("."),
            message: item.message,
          })),
        );
      } else {
        Object.defineProperty(req, key, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
    }
    if (details.length) {
      return next(
        new AppError(
          422,
          "VALIDATION_ERROR",
          "Dữ liệu đầu vào không hợp lệ.",
          details,
        ),
      );
    }
    return next();
  };
}

module.exports = { validate };
