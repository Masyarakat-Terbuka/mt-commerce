/**
 * CORS middleware. Wraps Hono's built-in `cors()` with config from `env`.
 *
 * `CORS_ORIGIN` is a comma-separated list. The wildcard "*" is allowed only
 * when no credentials are required; we set `credentials: true` because the
 * admin uses session cookies, so a wildcard origin would be ignored by the
 * browser. Operators should set explicit origins in production.
 */
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env.js";
import type { AppBindings } from "../lib/types.js";

function parseOrigins(raw: string): string[] | "*" {
  const trimmed = raw.trim();
  if (trimmed === "*" || trimmed === "") return "*";
  return trimmed
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function corsMiddleware(): MiddlewareHandler<AppBindings> {
  const origins = parseOrigins(env.corsOrigin);

  // When credentials are sent, the browser rejects "*" and requires the exact
  // origin in Access-Control-Allow-Origin. We echo whatever origin the request
  // came from when configured as wildcard, keeping development simple while
  // staying spec-compliant.
  const originHandler =
    origins === "*"
      ? (origin: string) => origin || "*"
      : (origin: string) => (origins.includes(origin) ? origin : null);

  return cors({
    origin: originHandler,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 600,
  });
}
