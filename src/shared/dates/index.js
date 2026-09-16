const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePlainDate(value) {
  if (!DATE_RE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatPlainDate(date) {
  return date.toISOString().slice(0, 10);
}

function databaseDate(value) {
  if (value instanceof Date) return formatPlainDate(value);
  const text = String(value);
  if (DATE_RE.test(text.slice(0, 10))) return text.slice(0, 10);
  throw new TypeError("Database value is not a valid plain date.");
}

function addDays(value, count) {
  const date =
    typeof value === "string"
      ? parsePlainDate(value)
      : new Date(value.getTime());
  date.setUTCDate(date.getUTCDate() + count);
  return formatPlainDate(date);
}

function diffDays(start, end) {
  return Math.round((parsePlainDate(end) - parsePlainDate(start)) / 86400000);
}

function enumerateNights(checkIn, checkOut) {
  const count = diffDays(checkIn, checkOut);
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    addDays(checkIn, index),
  );
}

function todayInTimezone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  addDays,
  databaseDate,
  diffDays,
  enumerateNights,
  formatPlainDate,
  parsePlainDate,
  todayInTimezone,
};
