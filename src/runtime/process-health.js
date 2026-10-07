const http = require("node:http");
// Optional loopback-only endpoint for container probes; no secrets or metrics
// exposed. Host dev leaves PROCESS_HEALTH_PORT unset, avoiding port conflicts.
async function startProcessHealth({
  check,
  port = process.env.PROCESS_HEALTH_PORT,
}) {
  if (!port) return { close: async () => {} };
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("INVALID_PROCESS_HEALTH_PORT");
  let pending;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health/live") {
      res.end("live");
      return;
    }
    if (req.url !== "/health/ready") {
      res.writeHead(404).end();
      return;
    }
    let timer;
    try {
      if (!pending) {
        pending = Promise.resolve().then(check);
        pending
          .finally(() => {
            pending = undefined;
          })
          .catch(() => {});
      }
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), 4000);
        }),
      ]);
      res.end("ready");
    } catch {
      res.writeHead(503).end("not ready");
    } finally {
      clearTimeout(timer);
    }
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", resolve);
  });
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  };
}
module.exports = { startProcessHealth };
