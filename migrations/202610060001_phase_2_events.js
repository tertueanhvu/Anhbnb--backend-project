exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE bookings ADD COLUMN event_version bigint NOT NULL DEFAULT 0;
    ALTER TABLE payments ADD COLUMN event_version bigint NOT NULL DEFAULT 0;
    CREATE TABLE outbox_events (
      event_id uuid PRIMARY KEY,
      aggregate_type text NOT NULL CHECK (aggregate_type IN ('booking','payment','catalog')),
      aggregate_id uuid NOT NULL,
      aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
      event_type text NOT NULL,
      request_id text,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (aggregate_type, aggregate_id, aggregate_version)
    );
    CREATE INDEX outbox_events_occurred_idx ON outbox_events(occurred_at);
    CREATE TABLE consumer_inbox (
      consumer_name text NOT NULL,
      event_id uuid NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer_name, event_id)
    );
    CREATE INDEX consumer_inbox_processed_idx ON consumer_inbox(processed_at);
    CREATE TABLE notification_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      template text NOT NULL,
      recipient_ref uuid NOT NULL,
      booking_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_until timestamptz,
      lock_token uuid,
      last_error_code text,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_id, channel, template, recipient_ref)
    );
    CREATE INDEX notification_jobs_due_idx ON notification_jobs(status, available_at);
    -- Not a FK: retain the version/tombstone after deleting a property.
    CREATE TABLE catalog_versions (
      property_id uuid PRIMARY KEY,
      version bigint NOT NULL DEFAULT 0,
      deleted boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE catalog_reference_versions (
      reference_kind text NOT NULL,
      reference_id uuid NOT NULL,
      aggregate_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      version bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (reference_kind, reference_id)
    );
  `);
};

exports.down = async function down() {
  throw new Error(
    "Phase 2 event records are durable. Roll back application flags; do not drop outbox/inbox/jobs without an explicit data migration.",
  );
};
