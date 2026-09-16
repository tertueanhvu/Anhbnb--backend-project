const { createIntervalJob } = require("../../src/jobs/create-interval-job");

describe("interval job overlap guard", () => {
  it("skips a second tick while the first one is running", async () => {
    let release;
    const blocker = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const job = createIntervalJob({
      name: "test",
      intervalMs: 1000,
      logger: { error: vi.fn() },
      task: async () => {
        calls += 1;
        await blocker;
        return { done: true };
      },
    });
    const first = job.tick();
    expect(await job.tick()).toEqual({ skipped: true });
    release();
    expect(await first).toEqual({ done: true });
    expect(calls).toBe(1);
  });
});
