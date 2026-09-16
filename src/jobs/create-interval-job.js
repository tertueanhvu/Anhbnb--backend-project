function createIntervalJob({ name, intervalMs, task, logger }) {
  let timer;
  let running = false;

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      return await task();
    } catch (error) {
      logger.error({ err: error, job: name }, "Background job failed");
      return { error: true };
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    isRunning: () => running,
  };
}

module.exports = { createIntervalJob };
