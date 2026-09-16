const { AppError } = require("../errors/app-error");

function asVndInteger(value, field = "amount") {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(
      500,
      "INVALID_MONEY_VALUE",
      `${field} phải là số nguyên VND không âm.`,
    );
  }
  return parsed;
}

function sumVnd(values) {
  return values.reduce((sum, value) => {
    const next = sum + asVndInteger(value);
    if (!Number.isSafeInteger(next)) {
      throw new AppError(
        500,
        "MONEY_OVERFLOW",
        "Giá trị tiền vượt giới hạn an toàn.",
      );
    }
    return next;
  }, 0);
}

module.exports = { asVndInteger, sumVnd };
