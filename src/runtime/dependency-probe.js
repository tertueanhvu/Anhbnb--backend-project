function createDependencyProbe(operation, timeoutMs = 2000) {
  let pending;
  return async () => {
    if (!pending) {
      pending = Promise.resolve().then(operation);
      pending
        .finally(() => {
          pending = undefined;
        })
        .catch(() => {});
    }
    let timer;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DEPENDENCY_PROBE_TIMEOUT")),
            timeoutMs,
          );
        }),
      ]);
      return true;
    } finally {
      clearTimeout(timer);
    }
  };
}
module.exports = { createDependencyProbe };
