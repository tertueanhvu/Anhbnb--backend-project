#!/usr/bin/env bash
set -euo pipefail
# Docker Desktop bind mounts can report +x despite macOS source mode 0644.
# Source init scripts through the official entrypoint, from the container filesystem.
cp /opt/anhbnb/init/00-init-databases.sh /docker-entrypoint-initdb.d/00-init-databases.sh
chmod 0644 /docker-entrypoint-initdb.d/00-init-databases.sh
exec /usr/local/bin/docker-entrypoint.sh "$@"
