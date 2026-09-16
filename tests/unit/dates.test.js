const {
  addDays,
  databaseDate,
  diffDays,
  enumerateNights,
  parsePlainDate,
  todayInTimezone,
} = require("../../src/shared/dates");

describe("date utilities", () => {
  it("validates real ISO plain dates", () => {
    expect(parsePlainDate("2028-02-29")).toBeInstanceOf(Date);
    expect(parsePlainDate("2027-02-29")).toBeNull();
    expect(parsePlainDate("2027-2-01")).toBeNull();
  });

  it("uses checkout as an exclusive boundary", () => {
    expect(enumerateNights("2026-12-31", "2027-01-02")).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(diffDays("2026-12-31", "2027-01-02")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("calculates today in the business timezone", () => {
    const now = new Date("2026-09-14T17:30:00.000Z");
    expect(todayInTimezone("Asia/Ho_Chi_Minh", now)).toBe("2026-09-15");
  });

  it("normalizes PostgreSQL date values without a timezone shift", () => {
    expect(databaseDate("2026-09-15")).toBe("2026-09-15");
    expect(databaseDate(new Date("2026-09-15T00:00:00.000Z"))).toBe(
      "2026-09-15",
    );
  });
});
