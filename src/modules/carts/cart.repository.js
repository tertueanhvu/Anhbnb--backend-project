function createCartRepository(db) {
  return {
    async getOrCreate(userId, trx = db) {
      const [cart] = await trx("carts")
        .insert({ user_id: userId })
        .onConflict("user_id")
        .merge({ updated_at: trx.fn.now() })
        .returning("*");
      return cart;
    },

    findByUserId(userId, trx = db) {
      return trx("carts").where({ user_id: userId }).first();
    },

    listItems(cartId, trx = db) {
      return trx("cart_items as ci")
        .join("room_types as rt", "rt.id", "ci.room_type_id")
        .join("properties as p", "p.id", "rt.property_id")
        .where("ci.cart_id", cartId)
        .select(
          "ci.*",
          "rt.property_id",
          "rt.name as room_type_name",
          "rt.base_price",
          "rt.currency",
          "p.name as property_name",
          "p.status as property_status",
        )
        .orderBy("ci.created_at");
    },

    async findOwnedItem(userId, itemId, trx = db) {
      return trx("cart_items as ci")
        .join("carts as c", "c.id", "ci.cart_id")
        .where({ "ci.id": itemId, "c.user_id": userId })
        .select("ci.*")
        .first();
    },

    async upsertItem(cartId, input, trx = db) {
      const [row] = await trx("cart_items")
        .insert({
          cart_id: cartId,
          room_type_id: input.roomTypeId,
          check_in: input.checkIn,
          check_out: input.checkOut,
          room_quantity: input.roomQuantity,
          adults: input.adults,
          children: input.children,
        })
        .onConflict(["cart_id", "room_type_id", "check_in", "check_out"])
        .merge({
          room_quantity: input.roomQuantity,
          adults: input.adults,
          children: input.children,
          updated_at: trx.fn.now(),
        })
        .returning("*");
      return row;
    },

    async updateItem(itemId, input, trx = db) {
      const [row] = await trx("cart_items")
        .where({ id: itemId })
        .update({
          check_in: input.checkIn,
          check_out: input.checkOut,
          room_quantity: input.roomQuantity,
          adults: input.adults,
          children: input.children,
          updated_at: trx.fn.now(),
        })
        .returning("*");
      return row;
    },

    deleteItem(itemId, trx = db) {
      return trx("cart_items").where({ id: itemId }).del();
    },

    clear(cartId, trx = db) {
      return trx("cart_items").where({ cart_id: cartId }).del();
    },
  };
}

module.exports = { createCartRepository };
