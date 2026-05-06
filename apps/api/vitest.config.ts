import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests should not need DATABASE_URL. Anything that does should mock or
    // skip in unit suites and run under a separate integration config later.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
    },
  },
});
