const jwt = require("jsonwebtoken");
const { createAuthService } = require("../../src/modules/auth/auth.service");

describe("auth service", () => {
  const env = {
    jwtSecret: "unit-test-secret-with-at-least-thirty-two-bytes",
    jwtExpiresIn: "1d",
  };

  it("normalizes email, hashes password and signs the expected JWT payload", async () => {
    let inserted;
    const repository = {
      findByEmail: async () => null,
      createUser: async (input) => {
        inserted = input;
        return {
          id: "10000000-0000-4000-8000-000000000001",
          email: input.email,
          password_hash: input.passwordHash,
          full_name: input.fullName,
          phone: input.phone,
          status: "ACTIVE",
          created_at: new Date(),
          updated_at: new Date(),
        };
      },
    };
    const service = createAuthService({ repository, env });
    const result = await service.register({
      email: " Guest@Example.COM ",
      password: "StrongPass1!",
      fullName: "Guest User",
      phone: "0901234567",
    });
    expect(inserted.email).toBe("guest@example.com");
    expect(inserted.passwordHash).not.toBe("StrongPass1!");
    expect(result.user.passwordHash).toBeUndefined();
    const payload = jwt.verify(result.accessToken, env.jwtSecret, {
      algorithms: ["HS256"],
    });
    expect(payload.id).toBe(result.user.id);
    expect(payload.email).toBe("guest@example.com");
  });

  it("uses the same credential error for unknown email", async () => {
    const service = createAuthService({
      repository: { findByEmail: async () => null },
      env,
    });
    await expect(
      service.login({ email: "missing@example.com", password: "wrong" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
  });
});
