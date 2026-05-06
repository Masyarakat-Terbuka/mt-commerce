/**
 * CORS middleware. Wraps Hono's built-in `cors()` with config from `env`.
 *
 * Security model:
 *   - `CORS_ORIGIN` is parsed as a comma-separated list. The committed
 *     `.env.example` defaults to explicit dev origins, never `*`.
 *   - Wildcard `*` is supported only when credentials are *not* required. In
 *     production, refusing the combination of `*` + `credentials: true` is a
 *     hard error: a permissive wildcard with cookies attached is the kind of
 *     misconfiguration that turns into a CSRF or session-theft vector.
 *   - Development is more lenient: when `CORS_ORIGIN` is unset, we allow
 *     localhost origins so contributors do not have to configure CORS to run
 *     the admin against the local API. Production has no such fallback —
 *     starting without `CORS_ORIGIN` set is a configuration error.
 */
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env.js";
import type { AppBindings } from "../lib/types.js";

const DEV_DEFAULT_ORIGINS = [
  "http://localhost:5173", // admin (Vite)
  "http://localhost:3000", // storefront (Astro)
];

interface ResolvedCors {
  origins: string[] | "*";
  credentials: boolean;
}

function resolveCors(): ResolvedCors {
  const raw = env.corsOrigin?.trim() ?? "";

  if (raw === "") {
    if (env.isProd) {
      throw new Error(
        "CORS_ORIGIN is required in production. Set it to a comma-separated " +
          "list of allowed origins (no '*').",
      );
    }
    return { origins: DEV_DEFAULT_ORIGINS, credentials: true };
  }

  if (raw === "*") {
    if (env.isProd) {
      throw new Error(
        "CORS_ORIGIN='*' is not allowed in production. Either set explicit " +
          "origins or run a frontend that does not require credentials.",
      );
    }
    // Wildcard is incompatible with credentialed requests per the CORS spec
    // (the browser rejects `Access-Control-Allow-Origin: *` when cookies are
    // attached). Disable credentials so the policy is consistent.
    return { origins: "*", credentials: false };
  }

  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { origins, credentials: true };
}

export function corsMiddleware(): MiddlewareHandler<AppBindings> {
  const { origins, credentials } = resolveCors();

  const originHandler =
    origins === "*"
      ? () => "*"
      : (origin: string) => (origins.includes(origin) ? origin : null);

  return cors({
    origin: originHandler,
    credentials,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 600,
  });
}
