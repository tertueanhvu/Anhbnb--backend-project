const { createLogTransport } = require("../../src/workers/notification-sender");
it("log transport makes no delivery promise and does not log contact PII", async () => {
  const logger = { info: vi.fn() };
  await createLogTransport(logger).send({
    job: { id: "job", event_id: "event", template: "booking-confirmed" },
    booking: {
      contact_email: "private@example.com",
      contact_phone: "0900000000",
    },
  });
  expect(logger.info).toHaveBeenCalledWith(
    { notificationId: "job", eventId: "event", template: "booking-confirmed" },
    "Notification logged (no email sent)",
  );
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
    "private@example.com",
  );
});
