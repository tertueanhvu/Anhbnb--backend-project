const { spawnSync } = require("node:child_process");

describe("database role separation", () => {
  function connection(testMode) {
    const script = `const env=require('./src/config/env').getEnv(); const config=require('./knexfile'); console.log(JSON.stringify({runtime:env.databaseUrl,migration:config.connection}));`;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        NODE_ENV: testMode ? "test" : "development",
        DATABASE_URL: "postgresql://app:pw@localhost:5433/dev",
        TEST_DATABASE_URL: "postgresql://test_app:pw@localhost:5433/app_test",
        MIGRATION_DATABASE_URL: "postgresql://migrator:pw@localhost:5433/dev",
        TEST_MIGRATION_DATABASE_URL:
          "postgresql://test_migrator:pw@localhost:5433/app_test",
        JWT_SECRET: "x".repeat(32),
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }
  it("keeps the application on the app role and CLI on the migration role", () => {
    const value = connection(false);
    expect(new URL(value.runtime).username).toBe("app");
    expect(new URL(value.migration).username).toBe("migrator");
  });
  it("uses test credentials for both connections in test mode", () => {
    const value = connection(true);
    expect(new URL(value.runtime).username).toBe("test_app");
    expect(new URL(value.migration).username).toBe("test_migrator");
  });
});
