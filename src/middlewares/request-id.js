const { randomUUID } = require("node:crypto");
const { eventContext } = require("../modules/events/event-context");

function requestId(req, res, next) {
  const supplied = req.get("X-Request-Id");
  req.id =
    supplied && /^[a-zA-Z0-9._:-]{1,200}$/.test(supplied)
      ? supplied
      : randomUUID();
  res.set("X-Request-Id", req.id);
  eventContext.run({ requestId: req.id }, next);
}

module.exports = { requestId };
