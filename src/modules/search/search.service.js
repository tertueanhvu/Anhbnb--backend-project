const { isDiscoveryPage } = require("./search.repository");
const { normalizeDiscoveryQuery } = require("../properties/public-catalog");
const { paginationMeta, parsePagination } = require("../../shared/pagination");
const { AppError } = require("../../shared/errors/app-error");
function createSearchService({
  repository,
  cache,
  freshness,
  cursor,
  loadCatalog,
  quoteCatalog,
  sortProperties,
  ttlSeconds = 30,
  clock = () => new Date(),
}) {
  async function discovery(query, generation, options = {}) {
    return cache.read({
      kind: "search",
      scope: "es",
      query: { ...query, indexGeneration: generation, ...options },
      ttlSeconds,
      validate: isDiscoveryPage,
      load: () => repository.page(query, options),
    });
  }
  return {
    async list(input) {
      const started = Date.now(),
        deadline = started + 2000;
      // Check PostgreSQL readiness even on a Redis cache hit. Never serve stale
      // projection indefinitely merely because cache is healthy.
      const generation = await freshness.check();
      const query = normalizeDiscoveryQuery(input),
        { page, limit, offset } = parsePagination(input);
      const withStay = Boolean(input.checkIn && input.checkOut);
      if (!withStay) {
        if (!input.cursor && offset + limit > 10000)
          throw new AppError(
            422,
            "USE_SEARCH_CURSOR",
            "Dùng nextCursor cho phân trang sâu.",
          );
        const after = input.cursor
          ? cursor.decode(input.cursor, { generation, query })
          : undefined;
        const found = await discovery(
          query,
          generation,
          after ? { after } : {},
        );
        const data = await loadCatalog(found.ids, query);
        return {
          data,
          meta: {
            ...paginationMeta(page, limit, found.total),
            quotedAt: clock().toISOString(),
            nextCursor:
              found.ids.length === limit && found.lastSort
                ? cursor.encode({ generation, query, sort: found.lastSort })
                : null,
          },
        };
      }
      if (input.cursor)
        throw new AppError(
          400,
          "DATED_CURSOR_UNSUPPORTED",
          "Search có ngày dùng page/limit trong giới hạn 1000 properties.",
        );
      const ids = [],
        seen = new Set();
      let total = Infinity,
        after;
      while (ids.length < total) {
        if (Date.now() > deadline)
          throw new AppError(
            422,
            "SEARCH_TOO_BROAD",
            "Thêm bộ lọc để thu hẹp tìm kiếm.",
          );
        const found = await discovery(
          { ...query, page: 1, limit: 100 },
          generation,
          after ? { after } : {},
        );
        total = found.total;
        if (total > 1000)
          throw new AppError(
            422,
            "SEARCH_TOO_BROAD",
            "Search có ngày giới hạn 1000 properties; hãy thêm bộ lọc.",
          );
        if (!found.ids.length && ids.length < total)
          throw new AppError(
            503,
            "SEARCH_CHANGED",
            "Catalog thay đổi trong lúc tìm kiếm; thử lại.",
          );
        for (const id of found.ids) {
          if (seen.has(id))
            throw new AppError(
              503,
              "SEARCH_CHANGED",
              "Catalog thay đổi trong lúc tìm kiếm; thử lại.",
            );
          seen.add(id);
          ids.push(id);
        }
        after = found.lastSort;
      }
      const catalog = await loadCatalog(ids, query);
      const quoted = await quoteCatalog(catalog, input, true, { deadline });
      // Relevance/distance ordering comes from discovery; price/name are sorted
      // after quote so date-search price order uses canonical totals.
      const sorted = ["price_asc", "price_desc", "name_asc"].includes(
        input.sort,
      )
        ? sortProperties(quoted, input.sort, true)
        : quoted;
      return {
        data: sorted.slice(offset, offset + limit),
        meta: {
          ...paginationMeta(page, limit, sorted.length),
          quotedAt: clock().toISOString(),
        },
      };
    },
  };
}
module.exports = { createSearchService };
