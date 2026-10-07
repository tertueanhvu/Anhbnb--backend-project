const { Kafka, logLevel, Partitioners } = require("kafkajs");
function createKafka(env, clientId = "anhbnb") {
  return new Kafka({
    clientId,
    brokers: env.kafkaBrokers,
    logLevel: logLevel.ERROR,
    connectionTimeout: 3000,
    requestTimeout: 10000,
    retry: { initialRetryTime: 200, retries: 5 },
  });
}
function createReliableProducer(kafka) {
  // KafkaJS uses idempotent rather than the Java producer's enable.idempotence.
  return kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner,
    retry: { retries: 10 },
  });
}
module.exports = { createKafka, createReliableProducer };
