const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID, createHmac } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { setupLocal } = require("./setup-local");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function eventually(check, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let error;
  while (Date.now() < end) {
    try {
      return await check();
    } catch (caught) {
      error = caught;
    }
    await delay(500);
  }
  throw error || new Error("E2E_TIMEOUT");
}
async function main() {
  const root = path.resolve(__dirname, ".."),
    project = `anhbnb-e2e-${randomUUID()}`;
  if (!/^anhbnb-e2e-[a-f0-9-]{36}$/.test(project))
    throw new Error("INVALID_DISPOSABLE_PROJECT");
  fs.mkdirSync(path.join(root, ".local"), { recursive: true });
  const artifact = fs.mkdtempSync(path.join(root, ".local", "compose-"));
  setupLocal(artifact);
  const envFile = path.join(artifact, ".env.docker"),
    config = dotenv.parse(fs.readFileSync(envFile));
  const runtimeEnv = {
    ...process.env,
    ...config,
    COMPOSE_PROJECT_NAME: project,
    SEARCH_BACKEND: "es",
    SEARCH_PROBES_ENABLED: "true",
    WORKER_HANDLERS: "notification,cache,search",
    COMPOSE_PROGRESS: "plain",
  };
  for (const name of [
    "POSTGRES_PORT",
    "REDIS_PORT",
    "KAFKA_EXTERNAL_PORT",
    "CONNECT_PORT",
    "ELASTICSEARCH_PORT",
    "API_PORT",
  ])
    runtimeEnv[name] = String(await freePort());
  const secrets = Object.entries(config)
    .filter(([key]) => /PASSWORD|SECRET|DATABASE_URL/.test(key))
    .map(([, value]) => value);
  const redact = (text) =>
    secrets.reduce(
      (result, value) => result.split(value).join("[REDACTED]"),
      text,
    );
  const prefix = [
    "compose",
    "-p",
    project,
    "--env-file",
    envFile,
    "--profile",
    "app",
    "--profile",
    "messaging",
    "--profile",
    "search",
    "--profile",
    "tools",
  ];
  async function compose(...args) {
    console.log(`[${project}] docker compose ${args.join(" ")}`);
    return new Promise((resolve, reject) => {
      const child = spawn("docker", [...prefix, ...args], {
        cwd: root,
        env: runtimeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
          output = (output + data.toString()).slice(-200000);
        });
      const timer = setTimeout(() => child.kill("SIGTERM"), 300000);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(
            new Error(redact(`Compose failed (${signal || code}):\n${output}`)),
          );
        else {
          console.log(redact(output.trim()));
          resolve(output);
        }
      });
    });
  }
  const base = `http://127.0.0.1:${runtimeEnv.API_PORT}`;
  const pool = new Pool({
    host: "127.0.0.1",
    port: Number(runtimeEnv.POSTGRES_PORT),
    database: "hotel_booking_dev",
    user: "hotel_booking_app",
    password: config.APP_DB_PASSWORD,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  // The intentional PostgreSQL outage also closes idle clients. Active query
  // failures still reject normally; do not let an idle-client event bypass cleanup.
  pool.on("error", (error) => {
    console.log(
      `E2E database connection interrupted: ${error.code || "UNKNOWN"}`,
    );
  });
  async function api(route, { method = "GET", body, token, key } = {}) {
    const response = await globalThis.fetch(`${base}${route}`, {
      method,
      signal: globalThis.AbortSignal.timeout(6000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  let passed = false;
  try {
    await compose("config", "--quiet");
    await compose("build", "api");
    await compose(
      "up",
      "-d",
      "postgres",
      "redis",
      "kafka",
      "elasticsearch",
      "--wait",
    );
    await compose("run", "--rm", "migrate");
    await compose("run", "--rm", "seed"); // Once, only this freshly-created disposable DB.
    await compose("run", "--rm", "kafka-init");
    await compose("run", "--rm", "cdc-init");
    await compose("up", "-d", "kafka-connect", "--wait");
    await compose("run", "--rm", "connector-init");
    await compose("run", "--rm", "search-init");
    await compose(
      "run",
      "--rm",
      "--no-deps",
      "api",
      "npm",
      "run",
      "catalog:repair",
    );
    await compose("up", "-d", "api", "worker", "scheduler", "--wait");
    const catalog = await eventually(async () => {
      const r = await api("/api/v1/properties?sort=price_asc");
      assert.equal(r.status, 200);
      assert.ok(r.body.data.length);
      return r.body.data;
    });
    const property = catalog[0],
      roomType = property.roomTypes[0];
    const email = `compose-${randomUUID()}@example.com`;
    const registered = await api("/api/v1/auth/register", {
      method: "POST",
      body: { email, password: "StrongPass1!", fullName: "Compose Guest" },
    });
    assert.equal(registered.status, 201);
    const token = registered.body.data.accessToken;
    const plus = (days) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const selected = {
      roomTypeId: roomType.id,
      checkIn: plus(100),
      checkOut: plus(102),
      roomQuantity: 1,
      adults: 2,
      children: 0,
    };
    const cart = await api("/api/v1/cart/items", {
      method: "POST",
      token,
      body: selected,
    });
    assert.equal(cart.status, 201);
    const bookingBody = {
      cartItemId: cart.body.data.id,
      contact: { fullName: "Compose Guest", email, phone: "0901234567" },
    };
    const key = `e2e-${randomUUID()}`;
    const booked = await api("/api/v1/bookings", {
      method: "POST",
      token,
      key,
      body: bookingBody,
    });
    assert.equal(booked.status, 201);
    const bookingId = booked.body.data.id;
    const duplicate = await api("/api/v1/bookings", {
      method: "POST",
      token,
      key,
      body: bookingBody,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.id, bookingId);
    assert.equal(
      (await api("/api/v1/cart", { token })).body.data.items.length,
      0,
    );
    const payment = await api(`/api/v1/bookings/${bookingId}/payments`, {
      method: "POST",
      token,
      body: { provider: "ZALOPAY" },
    });
    assert.equal(payment.status, 201);
    const row = (
      await pool.query(
        "SELECT app_trans_id, amount FROM payments WHERE id=$1",
        [payment.body.data.id],
      )
    ).rows[0];
    const data = JSON.stringify({
      app_id: "MOCK",
      app_trans_id: row.app_trans_id,
      amount: Number(row.amount),
      zp_trans_id: `mock-${randomUUID()}`,
      server_time: Date.now(),
    });
    const callback = {
      data,
      mac: createHmac("sha256", "mock-callback-key").update(data).digest("hex"),
      type: 1,
    };
    for (let n = 0; n < 2; n += 1)
      assert.equal(
        (
          await api("/api/v1/payments/zalopay/callback", {
            method: "POST",
            body: callback,
          })
        ).body.return_code,
        1,
      );
    assert.equal(
      (await api(`/api/v1/bookings/${bookingId}`, { token })).body.data.status,
      "CONFIRMED",
    );
    const delivered = await eventually(async () => {
      const r = await pool.query(
        "SELECT j.id FROM notification_jobs j JOIN outbox_events e ON e.event_id=j.event_id JOIN consumer_inbox i ON i.event_id=e.event_id AND i.consumer_name='notification-v1' WHERE e.aggregate_id=$1 AND j.status='SENT'",
        [bookingId],
      );
      assert.equal(r.rows.length, 2);
      return r.rows.map((item) => item.id).sort();
    });
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM room_availability WHERE booking_id=$1 AND status='BOOKED'",
            [bookingId],
          )
        ).rows[0].n,
      ),
      2,
    );
    await compose("restart", "worker");
    await eventually(async () => {
      const r = await compose(
        "exec",
        "-T",
        "worker",
        "node",
        "docker/healthcheck.js",
      );
      return r;
    });
    const afterRestart = (
      await pool.query(
        "SELECT j.id FROM notification_jobs j JOIN outbox_events e ON e.event_id=j.event_id WHERE e.aggregate_id=$1 AND j.status='SENT'",
        [bookingId],
      )
    ).rows
      .map((item) => item.id)
      .sort();
    assert.deepEqual(afterRestart, delivered);
    const name = `Compose-${randomUUID()}`;
    await compose(
      "run",
      "--rm",
      "--no-deps",
      "api",
      "npm",
      "run",
      "catalog:update",
      "--",
      "--property-id",
      property.id,
      "--name",
      name,
    );
    await eventually(async () => {
      const r = await api(`/api/v1/properties?q=${name}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.data[0]?.name, name);
    });
    await compose("stop", "redis");
    assert.equal((await api(`/api/v1/properties/${property.id}`)).status, 200);
    await compose("up", "-d", "redis", "--wait");
    // Run the existing API-v1 collection against THIS isolated stack, not dev.
    const newman = require("newman");
    await new Promise((resolve, reject) =>
      newman.run(
        {
          collection: require("../postman/Hotel-Booking.postman_collection.json"),
          environment: JSON.parse(
            fs.readFileSync(
              path.join(root, "postman/Local.postman_environment.json.example"),
              "utf8",
            ),
          ),
          envVar: [
            { key: "baseUrl", value: base },
            { key: "searchEnabled", value: "true" },
          ],
          reporters: "cli",
          timeoutRequest: 6000,
        },
        (error, summary) =>
          error || summary.run.failures.length
            ? reject(error || new Error("NEWMAN_ASSERTIONS_FAILED"))
            : resolve(),
      ),
    );
    const failures = await pool.query(
      "SELECT count(*) AS n FROM consumer_failures WHERE status='OPEN'",
    );
    assert.equal(Number(failures.rows[0].n), 0);
    await compose("stop", "postgres");
    assert.equal((await api("/health/ready")).status, 503);
    assert.equal((await api("/health/live")).status, 200);
    await compose("up", "-d", "postgres", "--wait");
    // Losing the singleton DB connection intentionally stops the scheduler.
    await compose("restart", "worker", "scheduler");
    await compose("up", "-d", "api", "worker", "scheduler", "--wait");
    await eventually(async () => {
      assert.equal((await api("/health/ready")).status, 200);
    });
    passed = true;
    console.log(
      JSON.stringify({
        result: "PASS",
        project,
        bookingConfirmed: true,
        outboxCdcInboxJobs: true,
        duplicateCallback: true,
        workerRestart: true,
        catalogProjection: true,
        redisFallback: true,
        databaseReadinessRecovery: true,
        postman: true,
      }),
    );
  } finally {
    await pool.end();
    if (!passed)
      await compose(
        "logs",
        "--tail",
        "30",
        "api",
        "worker",
        "scheduler",
        "kafka-connect",
      ).catch(() => {});
    console.log(
      `Removing ONLY disposable project ${project} and its test volumes. Dev volumes are untouched.`,
    );
    await compose("down", "--volumes", "--remove-orphans");
    console.log(
      `Private test setup retained for diagnostics at ${path.relative(root, artifact)} (Git-ignored).`,
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
