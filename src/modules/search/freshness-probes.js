const { Partitioners } = require("kafkajs");
const { createOutboxRepository } = require("../events/outbox.repository");
function probeKeys(partitions = 3) {
  const choose = Partitioners.DefaultPartitioner();
  const metadata = Array.from({ length: partitions }, (_, partitionId) => ({
    partitionId,
    leader: 0,
  }));
  const keys = new Map();
  for (let i = 1; keys.size < partitions && i < 10000; i += 1) {
    const id = `30802026-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    const partition = choose({
      topic: "catalog",
      partitionMetadata: metadata,
      message: { key: Buffer.from(id) },
    });
    if (!keys.has(partition)) keys.set(partition, id);
  }
  if (keys.size !== partitions)
    throw new Error("PROBE_PARTITION_KEYS_UNAVAILABLE");
  return keys;
}
function createFreshnessProbes({ db, partitions = 3 }) {
  const outbox = createOutboxRepository(),
    keys = probeKeys(partitions);
  return async () =>
    db.transaction(async (trx) => {
      const events = [];
      for (const [partition, id] of keys) {
        await trx("catalog_reference_versions")
          .insert({
            reference_kind: "freshness-probe",
            reference_id: id,
            aggregate_id: id,
          })
          .onConflict(["reference_kind", "reference_id"])
          .ignore();
        const [row] = await trx("catalog_reference_versions")
          .where({ reference_kind: "freshness-probe", reference_id: id })
          .update({ version: trx.raw("version + 1") })
          .returning("version");
        events.push(
          await outbox.append(trx, {
            aggregateType: "catalog",
            aggregateId: id,
            version: row.version,
            eventType: "CatalogFreshnessProbe",
            data: { partition, partition_count: partitions },
          }),
        );
      }
      return events;
    });
}
module.exports = { probeKeys, createFreshnessProbes };
