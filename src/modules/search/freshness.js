const { AppError } = require("../../shared/errors/app-error");
function createFreshnessGate({
  db,
  topic = "anhbnb.catalog.events.v1",
  partitions = 3,
  maxAgeMs = 60000,
}) {
  return {
    async check() {
      const result = await db
        .raw(
          `SELECT s.generation, s.maintenance,
      (SELECT count(*) FROM search_projection_progress p
        WHERE p.handler = 'search-indexer-v1' AND p.topic = ? AND p.generation = s.generation
        AND p.partition >= 0 AND p.partition < ?
        AND p.source_time >= now() - (? * interval '1 millisecond')
        AND p.source_time <= now() + interval '5 seconds'
        AND p.processed_at >= now() - (? * interval '1 millisecond')) AS fresh_partitions,
      (SELECT count(*) FROM consumer_failures WHERE consumer_name = 'search-indexer-v1' AND status = 'OPEN') AS unresolved
      FROM search_projection_state s WHERE singleton = true`,
          [topic, partitions, maxAgeMs, maxAgeMs],
        )
        .timeout(1000, { cancel: true })
        .catch(() => {
          throw new AppError(
            503,
            "SEARCH_NOT_READY",
            "Không xác minh được độ mới của search.",
          );
        });
      const state = result.rows[0];
      if (
        !state ||
        state.maintenance ||
        Number(state.fresh_partitions) !== partitions ||
        Number(state.unresolved)
      )
        throw new AppError(
          503,
          "SEARCH_NOT_READY",
          "Search projection chưa đồng bộ; thử lại sau.",
        );
      return state.generation;
    },
  };
}
module.exports = { createFreshnessGate };
