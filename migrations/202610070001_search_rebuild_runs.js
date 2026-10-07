exports.up = async function up(knex) {
  await knex.schema.createTable("search_rebuild_runs", (table) => {
    table.uuid("id").primary();
    table.text("target_index").notNullable();
    table.text("alias").notNullable();
    table.text("status").notNullable();
    table.jsonb("start_offsets");
    table.jsonb("cutover_offsets");
    table.jsonb("old_indices");
    table.text("error_code");
    table.timestamp("created_at", { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).defaultTo(knex.fn.now());
  });
};
exports.down = async function down() {
  throw new Error(
    "Keep rebuild diagnostics; use SEARCH_BACKEND=pg for rollback.",
  );
};
