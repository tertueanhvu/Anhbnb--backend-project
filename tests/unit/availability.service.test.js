const {
  buildAvailabilityQuote,
  validateCapacity,
} = require("../../src/modules/availability/availability.service");

function row(roomId, roomCode, date, status, price = 650000) {
  return {
    room_id: roomId,
    room_code: roomCode,
    stay_date: date,
    status,
    price,
    booking_id: status === "OPEN" ? null : "booking-id",
  };
}

describe("availability quote", () => {
  const nights = ["2026-10-10", "2026-10-11", "2026-10-12"];

  it("distinguishes nightly open rooms from rooms bookable for the whole stay", () => {
    const rows = [
      row("r1", "101", nights[0], "OPEN"),
      row("r1", "101", nights[1], "OPEN"),
      row("r1", "101", nights[2], "BOOKED"),
      row("r2", "102", nights[0], "BOOKED"),
      row("r2", "102", nights[1], "BOOKED"),
      row("r2", "102", nights[2], "OPEN"),
    ];
    const quote = buildAvailabilityQuote({
      rows,
      roomCount: 2,
      nights,
      roomQuantity: 1,
    });
    expect(quote.nightly.map((night) => night.openRooms)).toEqual([1, 1, 1]);
    expect(quote.bookableRooms).toBe(0);
    expect(quote.available).toBe(false);
  });

  it("sums the selected physical rooms and every nightly price", () => {
    const rows = [
      row("r1", "101", nights[0], "OPEN", 100),
      row("r1", "101", nights[1], "OPEN", 200),
      row("r1", "101", nights[2], "OPEN", 300),
      row("r2", "102", nights[0], "OPEN", 100),
      row("r2", "102", nights[1], "OPEN", 200),
      row("r2", "102", nights[2], "OPEN", 300),
    ];
    const quote = buildAvailabilityQuote({
      rows,
      roomCount: 2,
      nights,
      roomQuantity: 2,
    });
    expect(quote.available).toBe(true);
    expect(quote.selectedRooms.map((room) => room.roomCode)).toEqual([
      "101",
      "102",
    ]);
    expect(quote.subtotal).toBe(1200);
  });

  it("rejects a missing calendar row and excess guests", () => {
    expect(() =>
      buildAvailabilityQuote({
        rows: [],
        roomCount: 1,
        nights,
        roomQuantity: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "STAY_OUTSIDE_CALENDAR" }));
    expect(() =>
      validateCapacity({
        adults: 5,
        children: 0,
        roomQuantity: 2,
        maxGuests: 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "GUEST_CAPACITY_EXCEEDED" }),
    );
  });
});
