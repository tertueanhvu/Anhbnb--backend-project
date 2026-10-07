#!/usr/bin/env bash
set -euo pipefail
topics=/opt/kafka/bin/kafka-topics.sh
for domain in booking payment catalog; do
  "$topics" --bootstrap-server kafka:29092 --create --if-not-exists --topic "anhbnb.${domain}.events.v1" --partitions 3 --replication-factor 1 --config min.insync.replicas=1 --config retention.ms=604800000
done
"$topics" --bootstrap-server kafka:29092 --create --if-not-exists --topic anhbnb.events.dlq.v1 --partitions 1 --replication-factor 1 --config retention.ms=2592000000
"$topics" --bootstrap-server kafka:29092 --create --if-not-exists --topic anhbnb.connect.configs --partitions 1 --replication-factor 1 --config cleanup.policy=compact
for topic in offsets status; do
  "$topics" --bootstrap-server kafka:29092 --create --if-not-exists --topic "anhbnb.connect.${topic}" --partitions 3 --replication-factor 1 --config cleanup.policy=compact
done
