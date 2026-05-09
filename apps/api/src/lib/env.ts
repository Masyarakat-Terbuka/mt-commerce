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
  // Auth — Better Auth secret. Required in every non-test environment because
  // Better Auth refuses to sign cookies without it. The 32-char minimum is the
  // framework's recommendation (`openssl rand -base64 32` produces a value of
  // sufficient entropy). In `test` we provide a fixed dummy via vitest config.
  BETTER_AUTH_SECRET: isTestRun
    ? z.string().default("test-secret-test-secret-test-secret-test")
    : z.string().min(32, {
        message:
          "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with `openssl rand -base64 32`.",
      }),
  /**
   * Optional. Better Auth uses this to construct callback URLs and verify
   * origin headers. Leave unset in dev — env.ts derives a sensible default
   * from `PORT` below. Required in production deployments behind a real host.
   */
  BETTER_AUTH_URL: z
    .string()
    .url({ message: "BETTER_AUTH_URL must be a valid URL." })
    .optional(),
  SESSION_COOKIE_NAME: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message:
        "SESSION_COOKIE_NAME may only contain letters, digits, underscores, or hyphens.",
    })
    .default("mt_session"),
  /**
   * Default mirrors the production guard: secure cookies in production, plain
   * cookies in dev so a local browser without HTTPS can still authenticate.
   * Operators can force-enable in non-prod for testing TLS-terminated
   * proxies.
   */
  SESSION_COOKIE_SECURE: booleanFromString.optional(),
  /**
   * Indonesian PPN (Pajak Pertambahan Nilai) rate applied as a flat
   * placeholder by the cart's `getTotals`. Default `0.11` = 11%.
   *
   * This is intentionally a single global rate — the real tax module (see
   * `docs/v0.1-checklist.md` "Tax") will replace this with per-item /
   * per-region / per-exemption rate selection. Keeping the rate in the
   * environment lets operators dial it without a code change while we
   * wait for the proper module to land.
   *
   * Validation accepts a value in `[0, 1]` so a misconfiguration cannot
   * accidentally apply, say, a "11" (i.e. 1100%) to every cart.
   */
  TAX_PPN_RATE: z
    .union([z.number(), z.string()])
    .transform((value) =>
      typeof value === "number" ? value : Number.parseFloat(value),
    )
    .pipe(
      z
        .number()
        .min(0, { message: "TAX_PPN_RATE must be >= 0." })
        .max(1, { message: "TAX_PPN_RATE must be <= 1 (e.g. 0.11 = 11%)." }),
    )
    .default(0.11),
  // ---- Notifications ------------------------------------------------------
  /**
   * SMTP host for the notification module's email channel. When unset (and
   * NODE_ENV != production), the module falls back to the console channel
   * which logs the email for local development. In production the SMTP
   * channel REFUSES TO CONSTRUCT without these values, so the API fails
   * fast at boot rather than silently dropping verification emails.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z
    .union([z.number(), z.string()])
    .transform((value) =>
      typeof value === "number" ? value : Number.parseInt(value, 10),
    )
    .pipe(
      z
        .number()
        .int({ message: "SMTP_PORT must be an integer." })
        .min(1, { message: "SMTP_PORT must be >= 1." })
        .max(65535, { message: "SMTP_PORT must be <= 65535." }),
    )
    .default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /**
   * `From:` header on outgoing email. Default placeholder is suitable for
   * dev only; production deployments MUST set this to a deliverable address
   * the SMTP relay accepts.
   */
  SMTP_FROM: z.string().min(1).default("noreply@example.com"),
  /**
   * Default channel selection for the notification service. `console` is
   * the dev default — every send is logged at info level. `smtp` is the
   * production default and exercises the real SMTP adapter.
   *
   * Operators can force-flip in non-prod (e.g. to validate SMTP locally)
   * by setting this to `smtp` along with the SMTP_* variables above.
   */
  NOTIFICATION_DEFAULT_CHANNEL: z.enum(["console", "smtp"]).optional(),
  // ---- Uploads ------------------------------------------------------------
  /**
   * Local-disk directory for product image uploads. Resolved relative to
   * `apps/api/` when the API is started from there (the typical case);
   * absolute paths are honored as-is. The runner creates the directory on
   * boot if it does not exist.
   *
   * In a containerised deploy this should be a host-mounted volume so
   * uploads survive image rebuilds. The bundled `docker-compose.prod.yml`
   * mounts a named volume.
   */
  UPLOAD_DIR: z.string().min(1).default("./uploads"),
  /**
   * Public origin of this API. Used to build absolute URLs for uploaded
   * images so the storefront can render them without a path-resolve
   * helper. Defaults to `http://localhost:${PORT}` in dev; production
   * deployments MUST set this to the public URL of the API (e.g.
   * `https://api.mystore.example.com`) — Caddy + the prod compose pair
   * already terminate TLS at that subdomain.
   */
  API_PUBLIC_URL: z
    .string()
    .url({ message: "API_PUBLIC_URL must be a valid URL." })
    .optional(),
  /**
   * Maximum upload size in bytes for product images. Default 5 MiB —
   * generous for a JPEG/PNG/WebP under normal compression but not so
   * large that one upload exhausts the API's request memory. The
   * notification surface mirrors the limit in the route's 413 response.
   */
  MAX_UPLOAD_BYTES: z
    .union([z.number(), z.string()])
    .transform((value) =>
      typeof value === "number" ? value : Number.parseInt(value, 10),
    )
    .pipe(
      z
        .number()
        .int({ message: "MAX_UPLOAD_BYTES must be an integer." })
        .min(1024, { message: "MAX_UPLOAD_BYTES must be >= 1024 (1 KiB)." })
        .max(50 * 1024 * 1024, {
          message: "MAX_UPLOAD_BYTES must be <= 50 MiB.",
        }),
    )
    .default(5 * 1024 * 1024),
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

const isProd = data.NODE_ENV === "production";

export const env = {
  nodeEnv: data.NODE_ENV,
  isDev: data.NODE_ENV === "development",
  isProd,
  isTest: data.NODE_ENV === "test",
  port: data.PORT,
  logLevel: data.LOG_LEVEL,
  databaseUrl: data.DATABASE_URL ?? "",
  redisUrl: data.REDIS_URL,
  /** Raw, unparsed CORS_ORIGIN. The CORS middleware parses and validates it. */
  corsOrigin: data.CORS_ORIGIN,
  trustProxy: data.TRUST_PROXY,
  betterAuthSecret: data.BETTER_AUTH_SECRET,
  /**
   * Best-effort default: when the operator did not pin a URL, build one from
   * the port the API listens on. Better Auth uses this to construct callback
   * URLs and to verify the `Origin` header on credentialed requests.
   */
  betterAuthUrl:
    data.BETTER_AUTH_URL ?? `http://localhost:${String(data.PORT)}`,
  sessionCookieName: data.SESSION_COOKIE_NAME,
  /**
   * If the operator did not set the flag explicitly, derive from NODE_ENV:
   * secure cookies in production, plain cookies in dev so a local browser on
   * `http://localhost` still authenticates.
   */
  sessionCookieSecure: data.SESSION_COOKIE_SECURE ?? isProd,
  /**
   * Flat PPN rate the cart applies as a placeholder. The dedicated tax
   * module will replace this with proper per-item rate selection.
   */
  taxPpnRate: data.TAX_PPN_RATE,
  /**
   * SMTP config for the notification email channel. Optional in dev/test
   * (the channel falls back to console when the host is missing); the
   * SMTP adapter throws on construction in production when unset.
   */
  smtpHost: data.SMTP_HOST,
  smtpPort: data.SMTP_PORT,
  smtpUser: data.SMTP_USER,
  smtpPass: data.SMTP_PASS,
  smtpFrom: data.SMTP_FROM,
  /**
   * Default notification channel. When unset, derives from NODE_ENV:
   * `console` in dev/test, `smtp` in production. The notification service
   * consults this when `send({ channel })` does not pin the channel.
   */
  notificationDefaultChannel:
    data.NOTIFICATION_DEFAULT_CHANNEL ?? (isProd ? "smtp" : "console"),
  /**
   * Directory product image uploads are written to. Absolute paths are
   * honored; relative paths resolve from the API's working directory.
   */
  uploadDir: data.UPLOAD_DIR,
  /**
   * Public origin used to construct absolute URLs for uploaded images.
   * Falls back to `http://localhost:${PORT}` when unset, which is correct
   * for local development; production deployments are expected to pin
   * this to their api subdomain.
   */
  apiPublicUrl: data.API_PUBLIC_URL ?? `http://localhost:${String(data.PORT)}`,
  maxUploadBytes: data.MAX_UPLOAD_BYTES,
} as const;

export type Env = typeof env;
