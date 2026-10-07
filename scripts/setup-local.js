const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

// Generated development credentials stay in ignored files. Never print them.
function setupLocal(root = path.resolve(__dirname, "..")) {
  const files = [".env.docker", ".env.phase2"];
  if (files.some((file) => fs.existsSync(path.join(root, file)))) {
    throw new Error(
      "Refusing to overwrite local env files; keep or edit existing files explicitly.",
    );
  }
  const secret = () => randomBytes(32).toString("hex");
  const admin = secret(),
    app = secret(),
    migration = secret(),
    cdc = secret();
  const jwt = secret(),
    rate = secret();
  const config = (host, port, redisHost) =>
    [
      "NODE_ENV=development",
      "PORT=3000",
      "PAYMENT_PROVIDER_MODE=mock",
      "OUTBOX_ENABLED=true",
      `DATABASE_URL=postgresql://hotel_booking_app:${app}@${host}:${port}/hotel_booking_dev`,
      `TEST_DATABASE_URL=postgresql://hotel_booking_app:${app}@${host}:${port}/hotel_booking_test`,
      `MIGRATION_DATABASE_URL=postgresql://hotel_booking_migrator:${migration}@${host}:${port}/hotel_booking_dev`,
      `TEST_MIGRATION_DATABASE_URL=postgresql://hotel_booking_migrator:${migration}@${host}:${port}/hotel_booking_test`,
      `JWT_SECRET=${jwt}`,
      `RATE_LIMIT_KEY_SECRET=${rate}`,
      "JWT_EXPIRES_IN=1d",
      `REDIS_URL=redis://${redisHost}:6379`,
      "REDIS_NAMESPACE=anhbnb:dev",
      "BUSINESS_TIMEZONE=Asia/Ho_Chi_Minh",
      "BOOKING_HOLD_MINUTES=15",
      "BACKGROUND_JOBS_ENABLED=false",
      `KAFKA_BROKERS=${host === "postgres" ? "kafka:29092" : "localhost:9092"}`,
      `KAFKA_CONNECT_URL=http://${host === "postgres" ? "kafka-connect" : "localhost"}:8083`,
      "WORKER_HANDLERS=notification,cache",
      `ELASTICSEARCH_URL=http://${host === "postgres" ? "elasticsearch" : "localhost"}:9200`,
      "ELASTICSEARCH_INDEX=properties_read",
      "SEARCH_BACKEND=pg",
      "SEARCH_PROBES_ENABLED=false",
      "EMAIL_TRANSPORT=log",
      "TRUST_PROXY=false",
    ].join("\n") + "\n";
  const docker = [
    "POSTGRES_IMAGE=postgres:17.11-bookworm",
    "REDIS_IMAGE=redis:7.4.5-bookworm",
    "POSTGRES_PORT=5433",
    "REDIS_PORT=6379",
    `POSTGRES_PASSWORD=${admin}`,
    `APP_DB_PASSWORD=${app}`,
    `MIGRATION_DB_PASSWORD=${migration}`,
    `CDC_DB_PASSWORD=${cdc}`,
    config("postgres", 5432, "redis"),
  ].join("\n");
  fs.writeFileSync(path.join(root, files[0]), docker, {
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(root, files[1]),
    config("localhost", 5433, "localhost"),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created .env.docker and .env.phase2 with private local credentials. Existing .env preserved.",
  );
}
if (require.main === module) setupLocal();
module.exports = { setupLocal };
