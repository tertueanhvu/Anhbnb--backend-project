function createIntervalJob({ name, intervalMs, task, logger }) {
  let timer;
  let running = false;
  let pending;

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    let settle;
    pending = new Promise((resolve) => {
      settle = resolve;
    });
    try {
      return await task();
    } catch (error) {
      logger.error({ err: error, job: name }, "Background job failed");
      return { error: true };
    } finally {
      running = false;
      settle();
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pending;
    },
    tick,
    isRunning: () => running,
  };
}

module.exports = { createIntervalJob };
