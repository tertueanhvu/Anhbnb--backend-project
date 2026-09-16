const { db, closeDatabase } = require("../src/db/postgres");

async function main() {
  const [counts, invalidAvailability, mismatches] = await Promise.all([
    db.raw(`
      SELECT
        (SELECT count(*)::integer FROM rooms) AS rooms,
        (SELECT count(*)::integer FROM room_availability) AS availability_rows,
        (SELECT count(*)::integer FROM room_availability WHERE status <> 'OPEN') AS not_open
    `),
    db.raw(`
      SELECT count(*)::integer AS count
      FROM room_availability
      WHERE (booking_id IS NULL) <> (status IN ('OPEN', 'CLOSED'))
    `),
    db.raw(`
      SELECT count(*)::integer AS count
      FROM room_availability ra
      JOIN bookings b ON b.id = ra.booking_id
      WHERE (ra.status = 'HELD' AND b.status <> 'PENDING_PAYMENT')
         OR (ra.status = 'BOOKED' AND b.status <> 'CONFIRMED')
    `),
  ]);
  console.log(
    JSON.stringify(
      {
        ...counts.rows[0],
        invalidAvailabilityRows: invalidAvailability.rows[0].count,
        bookingStatusMismatches: mismatches.rows[0].count,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
