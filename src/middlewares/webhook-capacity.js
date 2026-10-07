function createWebhookCapacity(maxConcurrent = 16) {
  let active = 0;
  return (req, res, next) => {
    if (active >= maxConcurrent) {
      // Retriable failure, never an acknowledgement of a payment we did not apply.
      return res
        .status(503)
        .set("Retry-After", "1")
        .json({ return_code: 2, return_message: "callback_busy" });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

module.exports = { createWebhookCapacity };
