/**
 * Environment configuration. Reads `process.env` once at startup.
 *
 * Importing this module from many places is fine; it does not re-evaluate.
 * Tests that need to override values should mutate `process.env` before
 * importing the module under test, or inject overrides explicitly.
 */
import "dotenv/config";

const nodeEnv = (process.env.NODE_ENV ?? "development") as
  | "development"
  | "production"
  | "test";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

export const env = {
  nodeEnv,
  isDev: nodeEnv === "development",
  isProd: nodeEnv === "production",
  isTest: nodeEnv === "test",
  port,
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
} as const;

export type Env = typeof env;
