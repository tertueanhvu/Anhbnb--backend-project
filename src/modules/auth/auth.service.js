const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { AppError } = require("../../shared/errors/app-error");

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function toSafeUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function createAuthService({ repository, env }) {
  function signAccessToken(user) {
    return jwt.sign({ id: user.id, email: user.email }, env.jwtSecret, {
      algorithm: "HS256",
      expiresIn: env.jwtExpiresIn,
    });
  }

  return {
    async register(input) {
      const email = normalizeEmail(input.email);
      if (await repository.findByEmail(email)) {
        throw new AppError(
          409,
          "EMAIL_ALREADY_EXISTS",
          "Email đã được đăng ký.",
        );
      }
      const passwordHash = await bcrypt.hash(input.password, 10);
      let user;
      try {
        user = await repository.createUser({
          email,
          passwordHash,
          fullName: input.fullName.trim(),
          phone: input.phone?.trim() || null,
        });
      } catch (error) {
        if (error.code === "23505") {
          throw new AppError(
            409,
            "EMAIL_ALREADY_EXISTS",
            "Email đã được đăng ký.",
          );
        }
        throw error;
      }
      return { user: toSafeUser(user), accessToken: signAccessToken(user) };
    },

    async login(input) {
      const user = await repository.findByEmail(normalizeEmail(input.email));
      const valid = user
        ? await bcrypt.compare(input.password, user.password_hash)
        : false;
      if (!valid || user.status !== "ACTIVE") {
        throw new AppError(
          401,
          "INVALID_CREDENTIALS",
          "Email hoặc mật khẩu không đúng.",
        );
      }
      return { user: toSafeUser(user), accessToken: signAccessToken(user) };
    },

    async getProfile(userId) {
      const user = await repository.findActiveById(userId);
      if (!user)
        throw new AppError(
          401,
          "UNAUTHORIZED",
          "Tài khoản không còn hoạt động.",
        );
      return toSafeUser(user);
    },

    async updateProfile(userId, input) {
      const user = await repository.updateProfile(userId, {
        fullName: input.fullName?.trim(),
        phone: input.phone?.trim(),
      });
      if (!user || user.status !== "ACTIVE") {
        throw new AppError(
          401,
          "UNAUTHORIZED",
          "Tài khoản không còn hoạt động.",
        );
      }
      return toSafeUser(user);
    },
  };
}

module.exports = { createAuthService, normalizeEmail, toSafeUser };
