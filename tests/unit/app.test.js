const request = require("supertest");

describe("application foundation", () => {
  let createApp;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL =
      "postgresql://test:test@localhost:5432/hotel_booking_test";
    process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";
    ({ createApp } = require("../../src/app"));
  });

  afterAll(() => {
    delete process.env.NODE_ENV;
  });

  it("serves liveness without touching dependencies", async () => {
    const response = await request(createApp()).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "ok" } });
  });

  it("reports a controlled readiness failure", async () => {
    const response = await request(
      createApp({
        checkDatabase: async () => Promise.reject(new Error("secret db url")),
      }),
    ).get("/health/ready");
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("secret db url");
  });

  it("returns the JSON error envelope for unknown routes", async () => {
    const response = await request(createApp()).get("/missing");
    expect(response.status).toBe(404);
    expect(response.type).toMatch(/json/);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.requestId).toBeTruthy();
  });
});
