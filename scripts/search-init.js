const { getEnv } = require("../src/config/env");
const { createSearchClient } = require("../src/infrastructure/search/client");
const {
  indexTemplate,
  safeIndexName,
} = require("../src/infrastructure/search/property-index");
async function main() {
  const env = getEnv(),
    alias = safeIndexName(env.elasticsearchIndex);
  const client = createSearchClient({
    url: env.elasticsearchUrl,
    apiKey: env.elasticsearchApiKey,
    timeoutMs: 10000,
  });
  try {
    await client.request("GET", `/_alias/${alias}`);
    console.log("Search alias already exists; no index or alias replaced.");
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const index = "properties_v1";
  try {
    await client.request("HEAD", `/${index}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await client.request("PUT", `/${index}`, indexTemplate);
  }
  await client.request("POST", "/_aliases", {
    actions: [{ add: { index, alias, is_write_index: true } }],
  });
  console.log(
    "Search index/alias ready. Run catalog:repair explicitly, then worker with search handler and scheduler probes.",
  );
}
main().catch(() => {
  console.error(
    "Search initialization failed; check Elasticsearch connection, permissions and index configuration",
  );
  process.exitCode = 1;
});
