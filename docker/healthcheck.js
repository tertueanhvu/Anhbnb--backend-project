const http = require("node:http");
const port = process.env.PROCESS_HEALTH_PORT || process.env.PORT || 3000;
const request = http.get(
  { hostname: "127.0.0.1", port, path: "/health/ready", timeout: 4500 },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
request.on("timeout", () => {
  request.destroy();
  process.exitCode = 1;
});
request.on("error", () => {
  process.exitCode = 1;
});
