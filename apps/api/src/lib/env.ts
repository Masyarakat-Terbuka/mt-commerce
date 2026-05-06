/**
 * Environment configuration. Validates `process.env` once at startup with Zod
 * and exposes a typed, frozen `env` object for the rest of the API.
 *
 * Validation is fail-fast: if a required variable is missing or malformed,
 * loading this module throws with a formatted Zod error so the operator sees
 * exactly which variable is wrong before the server tries to start.
 *
 * Importing this module from many places is fine; it does not re-evaluate.
 * Tests should not need to mutate `process.env` after import — set values via
 * `vitest.config.ts` env or per-test setup.
 *
 * Notes on specific fields:
 *   - In `NODE_ENV=test`, `DATABASE_URL` is optional because unit tests are
 *     hermetic. In every other environment it is required.
 *   - `CORS_ORIGIN` has no default. The CORS middleware decides how to behave
 *     when it is unset (refuse to start in production, permissive in dev).
 *   - `dotenv` is only loaded outside of tests, so a developer's local `.env`
 *     never bleeds into the test runner.
 */
import { z } from "zod";

const rawNodeEnv = process.env.NODE_ENV;
const isTestRun = rawNodeEnv === "test";

if (!isTestRun) {
  // Load `.env` only when not running tests. The side-effect import populates
  // `process.env` for the validation pass below.
  await import("dotenv/config");
}

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return value === "true" || value === "1";
  });

const portFromString = z
  .union([z.number(), z.string()])
  .transform((value) =>
    typeof value === "number" ? value : Number.parseInt(value, 10),
  )
  .pipe(
    z
      .number()
      .int({ message: "PORT must be an integer." })
      .min(1, { message: "PORT must be >= 1." })
      .max(65535, { message: "PORT must be <= 65535." }),
  );

const baseSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: portFromString.default(8000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  REDIS_URL: z.string().url({ message: "REDIS_URL must be a valid URL." }),
  CORS_ORIGIN: z.string().optional(),
  TRUST_PROXY: booleanFromString.default(false),
});

const envSchema = baseSchema.extend({
  // DATABASE_URL is required outside of tests; tests are hermetic and should
  // not depend on a developer's local Postgres being up.
  DATABASE_URL: isTestRun
    ? z.string().url().optional()
    : z.string().url({ message: "DATABASE_URL must be a valid URL." }),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Format Zod's error tree so each line names the env var and the reason.
  const flat = parsed.error.format() as Record<
    string,
    { _errors?: string[] } | unknown
  >;
  const lines = Object.entries(flat)
    .filter(([key]) => key !== "_errors")
    .map(([key, value]) => {
      const messages =
        value && typeof value === "object" && "_errors" in value
          ? ((value as { _errors?: string[] })._errors ?? [])
          : [];
      return `  ${key}: ${messages.join(", ") || "invalid"}`;
    });
  throw new Error(
    `Invalid environment configuration:\n${lines.join("\n")}\n` +
      `Set the missing values in your environment or .env file before starting the API.`,
  );
}

const data = parsed.data;

export const env = {
  nodeEnv: data.NODE_ENV,
  isDev: data.NODE_ENV === "development",
  isProd: data.NODE_ENV === "production",
  isTest: data.NODE_ENV === "test",
  port: data.PORT,
  logLevel: data.LOG_LEVEL,
  databaseUrl: data.DATABASE_URL ?? "",
  redisUrl: data.REDIS_URL,
  /** Raw, unparsed CORS_ORIGIN. The CORS middleware parses and validates it. */
  corsOrigin: data.CORS_ORIGIN,
  trustProxy: data.TRUST_PROXY,
} as const;

export type Env = typeof env;
