exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE search_projection_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      generation uuid NOT NULL DEFAULT gen_random_uuid(),
      maintenance boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO search_projection_state(singleton) VALUES (true);
    CREATE TABLE search_projection_progress (
      handler text NOT NULL, topic text NOT NULL, partition integer NOT NULL,
      source_offset bigint NOT NULL, source_time timestamptz NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(), generation uuid NOT NULL,
      PRIMARY KEY(handler, topic, partition)
    );
  `);
};
exports.down = async function down() {
  throw new Error(
    "Keep search progress for diagnostics. Roll back SEARCH_BACKEND=pg instead.",
  );
};
