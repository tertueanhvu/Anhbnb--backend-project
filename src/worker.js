const { getEnv } = require("./config/env");
const { db, checkDatabase, closeDatabase } = require("./db/postgres");
const { logger } = require("./shared/security/logger");
const {
  createKafka,
  createReliableProducer,
} = require("./infrastructure/kafka/client");
const { createDeadLetterSink } = require("./infrastructure/kafka/dlq");
const { startEventConsumer } = require("./infrastructure/kafka/consumer");
const { createWorkerRuntime } = require("./runtime/worker-runtime");
const {
  createNotificationSender,
  createLogTransport,
} = require("./workers/notification-sender");
const { createIntervalJob } = require("./jobs/create-interval-job");
const { startProcessHealth } = require("./runtime/process-health");

async function startWorker() {
  const env = getEnv();
  if (!env.outboxEnabled)
    throw new Error(
      "Worker requires OUTBOX_ENABLED=true and migrated database",
    );
  await checkDatabase();
  const runtime = createWorkerRuntime({ db, env });
  const kafka = createKafka(env, "anhbnb-worker"),
    producer = createReliableProducer(kafka);
  const consumers = [];
  let senderJob,
    health,
    closing = false;
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    await health?.close();
    const deadline = setTimeout(() => process.exit(1), 45000);
    deadline.unref();
    await Promise.all(consumers.map((consumer) => consumer.stop()));
    await senderJob?.stop();
    await Promise.all(consumers.map((consumer) => consumer.disconnect()));
    await producer.disconnect();
    runtime.close();
    await closeDatabase();
    logger.info({ metrics: runtime.metrics.snapshot() }, "Worker stopped");
    clearTimeout(deadline);
    process.exitCode = code;
  }
  try {
    await producer.connect();
    const deadLetter = createDeadLetterSink({
      db,
      producer,
      topic: `${env.kafkaTopicPrefix}.events.dlq.v1`,
      metrics: runtime.metrics,
    });
    for (const name of env.workerHandlers) {
      consumers.push(
        await startEventConsumer({
          kafka,
          handler: runtime.handlers[name],
          deadLetter,
          retryMax: env.consumerRetryMax,
          metrics: runtime.metrics,
          topicPrefix: env.kafkaTopicPrefix,
          groupPrefix: env.kafkaGroupPrefix,
          onCrash: () => {
            logger.error(
              { handler: name },
              "Consumer stopped; shutting down worker",
            );
            void shutdown(1);
          },
        }),
      );
    }
    if (env.workerHandlers.includes("notification")) {
      const sender = createNotificationSender({
        db,
        transport: createLogTransport(logger),
        metrics: runtime.metrics,
      });
      senderJob = createIntervalJob({
        name: "notification-sender",
        intervalMs: env.notificationPollMs,
        task: sender.tick,
        logger,
      });
      senderJob.start();
    }
    health = await startProcessHealth({
      check: async () => {
        if (closing || consumers.length !== env.workerHandlers.length)
          throw new Error("WORKER_NOT_READY");
        await checkDatabase();
        const groups = await Promise.all(
          consumers.map((consumer) => consumer.describeGroup()),
        );
        if (
          groups.some(
            (group) => group.state !== "Stable" || !group.members.length,
          )
        )
          throw new Error("KAFKA_GROUP_NOT_READY");
      },
    });
    logger.info({ handlers: env.workerHandlers }, "Worker started");
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    return { shutdown, runtime };
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}
if (require.main === module)
  startWorker().catch(async () => {
    logger.error(
      "Worker startup failed; verify DB migrations, topics and Kafka connectivity",
    );
    await closeDatabase();
    process.exitCode = 1;
  });
module.exports = { startWorker };
