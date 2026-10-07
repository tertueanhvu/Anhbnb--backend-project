function createReferenceRepository(db) {
  return {
    amenities() {
      return db("amenities")
        .select("id", "code", "name", "icon")
        .orderBy("code")
        .timeout(2000, { cancel: true });
    },
    locations() {
      return db("properties")
        .where({ status: "ACTIVE" })
        .distinct("city", "district", "country_code")
        .orderBy(["country_code", "city", "district"])
        .timeout(2000, { cancel: true });
    },
  };
}
module.exports = { createReferenceRepository };
