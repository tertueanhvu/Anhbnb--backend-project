#!/usr/bin/env bash
set -euo pipefail
# PUT is repeatable and retains connector offsets/replication slot. Do not DELETE/recreate.
# The JSON uses an env provider reference, not the database password itself.
curl --fail --silent --show-error --output /dev/null --request PUT \
  --header 'Content-Type: application/json' \
  --data-binary @/init/anhbnb-outbox-connector.json \
  http://kafka-connect:8083/connectors/anhbnb-outbox/config
echo 'Connector configuration registered; use npm run cdc:check to verify task status.'
