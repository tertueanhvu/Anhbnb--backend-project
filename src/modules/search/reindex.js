const { randomUUID } = require("node:crypto");
const { stableJson } = require("../../infrastructure/redis/cache");
const {
  createPropertyIndex,
  safeIndexName,
  indexTemplate,
} = require("../../infrastructure/search/property-index");
const { createFreshnessProbes } = require("./freshness-probes");
const { startRebuildConsumer } = require("./rebuild-consumer");

async function scanSnapshots(db, visit) {
  // Full snapshots were committed atomically with these canonical revisions.
  // We require the latest payload, not the entire event history. Missing/pruned
  // payloads or manual SQL require catalog:repair before rebuilding.
  const missing = await db("properties as p")
    .leftJoin("catalog_versions as v", "v.property_id", "p.id")
    .whereNull("v.property_id")
    .first("p.id");
  if (missing) throw new Error("CATALOG_REPAIR_REQUIRED");
  let cursor;
  let count = 0;
  for (;;) {
    const query = db("catalog_versions as v")
      .leftJoin("outbox_events as e", function join() {
        this.on("e.aggregate_id", "=", "v.property_id")
          .andOn("e.aggregate_version", "=", "v.version")
          .andOnVal("e.aggregate_type", "catalog");
      })
      .select("v.property_id", "v.version", "e.payload")
      .orderBy("v.property_id")
      .limit(100);
    if (cursor) query.where("v.property_id", ">", cursor);
    const rows = await query;
    if (!rows.length) return count;
    for (const row of rows) {
      if (
        !row.payload?.data?.snapshot ||
        Number(row.version) !== row.payload.aggregate_version
      )
        throw new Error("CATALOG_REPAIR_REQUIRED");
    }
    await visit(rows.map((row) => row.payload));
    count += rows.length;
    cursor = rows.at(-1).property_id;
  }
}

async function validateRebuiltIndex({ db, client, target }) {
  const count = await scanSnapshots(db, async (events) => {
    const result = await client.request("POST", `/${target}/_mget`, {
      ids: events.map((event) => event.aggregate_id),
    });
    for (let i = 0; i < events.length; i += 1) {
      const doc = result.docs[i],
        event = events[i];
      if (
        !doc?.found ||
        doc._version !== event.aggregate_version ||
        stableJson(doc._source) !== stableJson(event.data.snapshot)
      )
        throw new Error("REBUILD_VALIDATION_FAILED");
    }
  });
  if ((await client.request("GET", `/${target}/_count`)).count !== count)
    throw new Error("REBUILD_COUNT_MISMATCH");
  return count;
}

async function reindexSearch({
  db,
  client,
  kafka,
  cache,
  target,
  alias = "properties_read",
  topic = "anhbnb.catalog.events.v1",
  afterBackfill = async () => {},
}) {
  safeIndexName(target);
  safeIndexName(alias);
  if (target === alias) throw new Error("REBUILD_TARGET_IS_ALIAS");
  const runId = randomUUID(),
    admin = kafka.admin();
  let rebuild,
    registered = false;
  const owner = await db.client.acquireConnection();
  let locked = false;
  try {
    const acquired = await db
      .raw("SELECT pg_try_advisory_lock(?) AS locked", [30802029])
      .connection(owner);
    locked = acquired.rows[0].locked;
    if (!locked) throw new Error("REBUILD_ALREADY_RUNNING");
    // PUT fails if target already exists. Never truncate/reuse someone else's index.
    await client.request("PUT", `/${target}`, indexTemplate);
    await db("search_rebuild_runs").insert({
      id: runId,
      target_index: target,
      alias,
      status: "STARTED",
    });
    registered = true;
    await admin.connect();
    const start = await admin.fetchTopicOffsets(topic);
    if (start.length !== 3) throw new Error("REBUILD_EXPECTS_THREE_PARTITIONS");
    await db("search_rebuild_runs")
      .where({ id: runId })
      .update({ start_offsets: JSON.stringify(start) });
    const index = createPropertyIndex({
      client,
      index: target,
      requireAlias: false,
      refresh: false,
    });
    rebuild = await startRebuildConsumer({ kafka, admin, topic, start, index });
    await scanSnapshots(db, async (events) => {
      for (const event of events) await index.apply(event);
    });
    await afterBackfill(); // Test seam: a concurrent catalog commit must survive cutover.
    const result = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '5s'");
      // Only catalog writers acquire this fence. Booking/payment keep running.
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [30802027]);
      await db("search_rebuild_runs")
        .where({ id: runId })
        .update({ status: "CATCHING_UP", updated_at: db.fn.now() });
      // Committed AFTER every pre-fence catalog transaction; these markers must
      // traverse WAL/CDC, not a direct producer, to establish a true barrier.
      const barriers = await createFreshnessProbes({ db })();
      await rebuild.waitFor({
        eventIds: barriers.map((event) => event.event_id),
      });
      const cutover = await admin.fetchTopicOffsets(topic);
      for (const row of cutover) {
        const original = start.find((item) => item.partition === row.partition);
        if (!original || BigInt(row.low) > BigInt(original.offset))
          throw new Error("REBUILD_RETENTION_GAP");
      }
      await rebuild.waitFor({ offsets: cutover });
      await rebuild.close();
      rebuild = null;
      await index.refresh();
      const count = await validateRebuiltIndex({ db: trx, client, target });
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [30802028]);
      let oldIndices = [];
      try {
        oldIndices = Object.keys(
          await client.request("GET", `/_alias/${alias}`),
        );
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      // Persist maintenance BEFORE the external swap. A crash/uncertain HTTP
      // result leaves search fail-closed until a fresh rebuild completes.
      const generation = randomUUID();
      await db.transaction(async (stateTrx) => {
        await stateTrx("search_projection_state")
          .where({ singleton: true })
          .update({
            maintenance: true,
            generation,
            updated_at: stateTrx.fn.now(),
          });
        await stateTrx("search_rebuild_runs")
          .where({ id: runId })
          .update({
            status: "CUTOVER",
            cutover_offsets: JSON.stringify(cutover),
            old_indices: JSON.stringify(oldIndices),
            updated_at: stateTrx.fn.now(),
          });
      });
      await client.request("POST", "/_aliases", {
        actions: [
          ...oldIndices.map((indexName) => ({
            remove: { index: indexName, alias, must_exist: true },
          })),
          { add: { index: target, alias, is_write_index: true } },
        ],
      });
      await cache.invalidate("search", "es");
      await db.transaction(async (stateTrx) => {
        await stateTrx("search_projection_state")
          .where({ singleton: true })
          .update({ maintenance: false, updated_at: stateTrx.fn.now() });
        await stateTrx("search_rebuild_runs")
          .where({ id: runId })
          .update({ status: "COMPLETED", updated_at: stateTrx.fn.now() });
      });
      return {
        runId,
        target,
        alias,
        oldIndices,
        count,
        generation,
        startOffsets: start,
        cutoverOffsets: cutover,
      };
    });
    return result;
  } catch (error) {
    if (registered)
      await db("search_rebuild_runs")
        .where({ id: runId })
        .update({
          status: "FAILED",
          error_code: "REBUILD_FAILED_CHECK_LOG_AND_MAINTENANCE",
          updated_at: db.fn.now(),
        })
        .catch(() => {});
    throw error;
  } finally {
    if (rebuild) await rebuild.close().catch(() => {});
    await admin.disconnect().catch(() => {});
    if (locked)
      await db
        .raw("SELECT pg_advisory_unlock(?)", [30802029])
        .connection(owner);
    await db.client.releaseConnection(owner);
  }
}
module.exports = { reindexSearch, scanSnapshots, validateRebuiltIndex };
