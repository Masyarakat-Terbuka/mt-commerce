/**
 * Smoke test for env validation: the test runner sets NODE_ENV=test and
 * REDIS_URL via `vitest.config.ts`, so the module should load and expose a
 * frozen, typed `env`. DATABASE_URL is allowed to be absent in tests.
 */
import { describe, expect, it } from "vitest";
import { env } from "../../src/lib/env.js";

describe("env (test mode)", () => {
  it("loads with NODE_ENV=test and tolerates a missing DATABASE_URL", () => {
    expect(env.nodeEnv).toBe("test");
    expect(env.isTest).toBe(true);
    expect(env.isProd).toBe(false);
  });

  it("parses REDIS_URL as a valid URL", () => {
    expect(env.redisUrl).toMatch(/^redis:\/\//);
  });

  it("defaults TRUST_PROXY to false when unset", () => {
    expect(env.trustProxy).toBe(false);
  });

  it("does not default CORS_ORIGIN to '*'", () => {
    expect(env.corsOrigin).not.toBe("*");
  });
});
