const { createInboxRepository } = require("../modules/events/inbox.repository");
function createSearchIndexer({ db, index, cache, partitions = 3, metrics }) {
  const name = "search-indexer-v1";
  return {
    name,
    topics: ["catalog"],
    async handle(event, source = {}) {
      return db.transaction(async (connection) => {
        // Reindex's exclusive fence waits for every in-flight alias write and
        // prevents new writes/probes until alias + generation cutover is complete.
        await connection.raw("SET LOCAL lock_timeout = '2s'");
        await connection.raw(
          "SELECT pg_advisory_xact_lock_shared(?)",
          [30802028],
        );
        const inbox = createInboxRepository(connection, metrics);
        if (event.aggregate_type !== "catalog")
          throw new Error("INVALID_SEARCH_EVENT");
        if (event.event_type === "CatalogFreshnessProbe") {
          if (
            source.replay ||
            event.data.partition_count !== partitions ||
            event.data.partition !== source.partition ||
            !Number.isInteger(source.partition)
          )
            throw new Error("INVALID_FRESHNESS_PROBE");
          return inbox.transaction(name, event.event_id, async (trx) => {
            const state = await trx("search_projection_state")
              .where({ singleton: true })
              .first();
            await trx.raw(
              `INSERT INTO search_projection_progress(handler,topic,partition,source_offset,source_time,generation)
          VALUES (?,?,?,?,?,?) ON CONFLICT(handler,topic,partition) DO UPDATE SET
          source_offset=excluded.source_offset, source_time=excluded.source_time, generation=excluded.generation, processed_at=now()
          WHERE search_projection_progress.source_offset < excluded.source_offset OR search_projection_progress.generation <> excluded.generation`,
              [
                name,
                source.topic,
                source.partition,
                source.offset,
                event.occurred_at,
                state.generation,
              ],
            );
          });
        }
        return inbox.external(name, event.event_id, async () => {
          if (event.event_type === "AmenityChanged") return; // Corresponding property snapshots follow.
          if (
            ![
              "PropertyUpserted",
              "PropertyDeleted",
              "RoomTypeUpserted",
              "RoomTypeDeleted",
            ].includes(event.event_type)
          )
            throw new Error("UNSUPPORTED_SEARCH_EVENT");
          await index.apply(event);
          await cache.invalidate("search", "es");
        });
      });
    },
  };
}
module.exports = { createSearchIndexer };
