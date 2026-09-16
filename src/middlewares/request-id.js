const { randomUUID } = require("node:crypto");

function requestId(req, res, next) {
  req.id = req.get("X-Request-Id") || randomUUID();
  res.set("X-Request-Id", req.id);
  next();
}

module.exports = { requestId };
