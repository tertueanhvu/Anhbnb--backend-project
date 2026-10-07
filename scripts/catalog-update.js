const { parseArgs } = require("node:util");
const { db, closeDatabase } = require("../src/db/postgres");
const {
  createOutboxRepository,
} = require("../src/modules/events/outbox.repository");
const {
  createCatalogWriteService,
} = require("../src/modules/catalog/catalog-write.service");
const { createRedisClient } = require("../src/infrastructure/redis/client");
const { createPublicCache } = require("../src/infrastructure/redis/cache");
const { getEnv } = require("../src/config/env");

async function main() {
  const { values } = parseArgs({
    options: { "property-id": { type: "string" }, name: { type: "string" } },
  });
  if (!values["property-id"] || !values.name)
    throw new Error(
      "Usage: npm run catalog:update -- --property-id <uuid> --name <name>",
    );
  const env = getEnv();
  const redis = createRedisClient({ url: env.redisUrl });
  try {
    const service = createCatalogWriteService({
      db,
      outbox: createOutboxRepository(),
      cache: createPublicCache({ redis, namespace: env.redisNamespace }),
    });
    const event = await service.updateProperty(values["property-id"], {
      name: values.name,
    });
    console.log(
      JSON.stringify({
        eventId: event.event_id,
        version: event.aggregate_version,
        status: "committed",
      }),
    );
  } finally {
    redis.close();
  }
}
main()
  .catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
