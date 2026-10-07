const { db, closeDatabase } = require("../src/db/postgres");
const {
  createOutboxRepository,
} = require("../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../src/modules/catalog/catalog-write.service");

async function main() {
  const service = createCatalogWriteService({
    db,
    outbox: createOutboxRepository(),
  });
  // Explicit bootstrap/repair, never a startup hook. No seed/reset or ID replacement.
  const properties = await db("properties").select("id").orderBy("id");
  const deleted = await db("catalog_versions as v")
    .where({ deleted: true })
    .whereNotExists(db("properties as p").whereRaw("p.id = v.property_id"))
    .select("property_id as id");
  let emitted = 0;
  for (const property of [...properties, ...deleted]) {
    await service.repairProperty(property.id);
    emitted += 1;
  }
  console.log(JSON.stringify({ snapshots: emitted, status: "committed" }));
}
main()
  .catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
