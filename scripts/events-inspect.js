const { db, closeDatabase } = require("../src/db/postgres");
async function main() {
  const [outbox, inbox, jobs, failures] = await Promise.all([
    db("outbox_events")
      .count("* as count")
      .min("occurred_at as oldest")
      .first(),
    db("consumer_inbox")
      .select("consumer_name")
      .count("* as count")
      .groupBy("consumer_name"),
    db("notification_jobs")
      .select("status")
      .count("* as count")
      .groupBy("status"),
    db("consumer_failures")
      .where({ status: "OPEN" })
      .select("consumer_name")
      .count("* as count")
      .groupBy("consumer_name"),
  ]);
  console.log(
    JSON.stringify(
      {
        outbox,
        inbox,
        notifications: jobs,
        unresolvedFailures: failures,
        retention:
          "No automatic pruning. Outbox >=30d, inbox/jobs >=90d; never prune unresolved jobs/failures. Check CDC catch-up before any archival.",
      },
      null,
      2,
    ),
  );
}
main()
  .catch(() => {
    console.error("Event inspection failed; check database and migrations");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
