const axios = require("axios");
function createSearchClient({ url, timeoutMs = 2000, apiKey = "" }) {
  const client = axios.create({
    baseURL: url,
    timeout: timeoutMs,
    maxRedirects: 0,
    maxContentLength: 8 * 1024 * 1024,
    headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
  });
  return {
    async request(method, path, data) {
      try {
        return (await client.request({ method, url: path, data })).data;
      } catch (cause) {
        const error = new Error("ELASTICSEARCH_REQUEST_FAILED");
        error.code = "ELASTICSEARCH_REQUEST_FAILED";
        error.status = cause.response?.status;
        // Deliberately don't retain axios config/headers or response bodies.
        throw error;
      }
    },
  };
}
module.exports = { createSearchClient };
