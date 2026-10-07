#!/usr/bin/env bash
set -euo pipefail
# This entrypoint is run only on an empty PostgreSQL volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=migration_password="$MIGRATION_DB_PASSWORD" \
  --set=cdc_password="$CDC_DB_PASSWORD" <<'SQL'
CREATE ROLE hotel_booking_app LOGIN PASSWORD :'app_password';
CREATE ROLE hotel_booking_migrator LOGIN PASSWORD :'migration_password';
CREATE ROLE hotel_booking_cdc LOGIN REPLICATION PASSWORD :'cdc_password';
CREATE DATABASE hotel_booking_dev OWNER hotel_booking_migrator;
CREATE DATABASE hotel_booking_test OWNER hotel_booking_migrator;
SQL

for database in hotel_booking_dev hotel_booking_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hotel_booking_app, hotel_booking_cdc;
GRANT CONNECT ON DATABASE :DBNAME TO hotel_booking_app, hotel_booking_cdc;
ALTER DEFAULT PRIVILEGES FOR ROLE hotel_booking_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotel_booking_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hotel_booking_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hotel_booking_app;
SQL
done
