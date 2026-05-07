import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests should not need DATABASE_URL. Anything that does should mock or
    // skip in unit suites and run under a separate integration config later.
    // REDIS_URL is required by `env.ts` even in tests; we provide a dummy
    // value so the validator passes without forcing a real Redis instance.
    // BETTER_AUTH_SECRET is similarly required outside of `test`; we set a
    // fixed value here to keep the validator happy without coupling tests
    // to a real secret.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-test",
    },
  },
});
