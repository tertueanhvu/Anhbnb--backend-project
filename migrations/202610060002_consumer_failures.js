exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE consumer_failures (
    failure_id text PRIMARY KEY,
    consumer_name text NOT NULL,
    event_id uuid,
    topic text NOT NULL,
    partition integer NOT NULL,
    source_offset bigint NOT NULL,
    error_code text NOT NULL,
    attempts integer NOT NULL,
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (consumer_name, topic, partition, source_offset)
  ); CREATE INDEX consumer_failures_open_idx ON consumer_failures(consumer_name, status);`);
};
exports.down = async function down() {
  throw new Error(
    "Retain unresolved consumer failures; rollback application, not the failure ledger.",
  );
};
