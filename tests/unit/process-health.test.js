const { createDependencyProbe } = require("../../src/runtime/dependency-probe");

describe("bounded dependency readiness", () => {
  it("returns true after a successful dependency check", async () => {
    await expect(createDependencyProbe(async () => 1)()).resolves.toBe(true);
  });
  it("times out callers but coalesces an in-flight dependency operation", async () => {
    let release;
    const operation = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const probe = createDependencyProbe(operation, 20);
    const results = await Promise.allSettled([probe(), probe(), probe()]);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          result.reason.message === "DEPENDENCY_PROBE_TIMEOUT",
      ),
    ).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    operation.mockResolvedValue(1);
    await expect(probe()).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("does not cache failures and can recover", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(1);
    const probe = createDependencyProbe(operation);
    await expect(probe()).rejects.toThrow("down");
    await expect(probe()).resolves.toBe(true);
  });
});
