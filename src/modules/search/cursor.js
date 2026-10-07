const { createHmac, timingSafeEqual } = require("node:crypto");
const { AppError } = require("../../shared/errors/app-error");
const { hashQuery } = require("../../infrastructure/redis/cache");
function querySignature(query) {
  const { page, cursor, ...filters } = query;
  void page;
  void cursor;
  return hashQuery(filters);
}
function createSearchCursor(secret) {
  const sign = (text) =>
    createHmac("sha256", secret)
      .update(`search-cursor-v1:${text}`)
      .digest("base64url");
  return {
    encode({ generation, query, sort }) {
      const text = Buffer.from(
        JSON.stringify({
          v: 1,
          generation,
          signature: querySignature(query),
          sort,
          issuedAt: Date.now(),
        }),
      ).toString("base64url");
      return `${text}.${sign(text)}`;
    },
    decode(cursor, { generation, query }) {
      try {
        if (cursor.length > 4000) throw new Error();
        const [text, mac, extra] = cursor.split(".");
        const expected = Buffer.from(sign(text));
        if (
          extra ||
          !mac ||
          Buffer.byteLength(mac) !== expected.length ||
          !timingSafeEqual(Buffer.from(mac), expected)
        )
          throw new Error();
        const value = JSON.parse(Buffer.from(text, "base64url").toString());
        if (
          value.v !== 1 ||
          value.generation !== generation ||
          value.signature !== querySignature(query) ||
          Date.now() - value.issuedAt > 300000 ||
          !Array.isArray(value.sort) ||
          value.sort.length !== 2
        )
          throw new Error();
        return value.sort;
      } catch {
        throw new AppError(
          400,
          "SEARCH_CURSOR_EXPIRED",
          "Cursor hết hạn hoặc không khớp query; bắt đầu lại từ trang đầu.",
        );
      }
    },
  };
}
module.exports = { createSearchCursor };
