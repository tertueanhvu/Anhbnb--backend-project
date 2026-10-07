function createInboxRepository(db, metrics) {
  return {
    // Unique insert serializes concurrent deliveries. A failed effect rolls this
    // insert back too, so another delivery can legitimately try again.
    async transaction(consumerName, eventId, operation) {
      return db.transaction(async (trx) => {
        const inserted = await trx("consumer_inbox")
          .insert({ consumer_name: consumerName, event_id: eventId })
          .onConflict(["consumer_name", "event_id"])
          .ignore()
          .returning("event_id");
        if (!inserted.length) {
          metrics?.increment(`consumer.${consumerName}.dedup`);
          return { duplicate: true };
        }
        await operation(trx);
        return { duplicate: false };
      });
    },
    async external(consumerName, eventId, operation) {
      // Only an optimization, NOT a lock. Concurrent external writes must be
      // independently idempotent (cache generation bump / ES version guard).
      if (
        await db("consumer_inbox")
          .where({ consumer_name: consumerName, event_id: eventId })
          .first()
      ) {
        metrics?.increment(`consumer.${consumerName}.dedup`);
        return { duplicate: true };
      }
      await operation();
      await db("consumer_inbox")
        .insert({ consumer_name: consumerName, event_id: eventId })
        .onConflict(["consumer_name", "event_id"])
        .ignore();
      return { duplicate: false };
    },
  };
}
module.exports = { createInboxRepository };
