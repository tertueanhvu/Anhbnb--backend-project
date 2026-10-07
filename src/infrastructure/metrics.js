// Bounded, low-cardinality process metrics. Never label with user IDs or raw queries.
function createMetrics() {
  const counters = new Map();
  return {
    increment(name, amount = 1) {
      counters.set(name, (counters.get(name) || 0) + amount);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
  };
}

module.exports = { createMetrics };
