const {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
} = require("../../config/constants");

function parsePagination(query = {}) {
  const page = Number(query.page ?? DEFAULT_PAGE);
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
}

function paginationMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

const paginationQuery = {
  page: { default: DEFAULT_PAGE, min: 1 },
  limit: { default: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT },
};

module.exports = { paginationMeta, paginationQuery, parsePagination };
