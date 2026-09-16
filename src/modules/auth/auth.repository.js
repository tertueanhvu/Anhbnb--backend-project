function createAuthRepository(db) {
  return {
    findByEmail(email, trx = db) {
      return trx("users").where({ email }).first();
    },

    findById(id, trx = db) {
      return trx("users").where({ id }).first();
    },

    findActiveById(id, trx = db) {
      return trx("users").where({ id, status: "ACTIVE" }).first();
    },

    async createUser(input, trx = db) {
      const [row] = await trx("users")
        .insert({
          email: input.email,
          password_hash: input.passwordHash,
          full_name: input.fullName,
          phone: input.phone || null,
          status: "ACTIVE",
        })
        .returning("*");
      return row;
    },

    async updateProfile(id, input, trx = db) {
      const patch = { updated_at: trx.fn.now() };
      if (input.fullName !== undefined) patch.full_name = input.fullName;
      if (input.phone !== undefined) patch.phone = input.phone || null;
      const [row] = await trx("users")
        .where({ id })
        .update(patch)
        .returning("*");
      return row;
    },
  };
}

module.exports = { createAuthRepository };
