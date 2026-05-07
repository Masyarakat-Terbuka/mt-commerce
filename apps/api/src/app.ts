/**
 * Hono app factory.
 *
 * Middleware order is deliberate:
 *   1. requestId      — every other layer references it for correlation
 *   2. logger         — needs the request ID; emits the request line on completion
 *   3. cors           — short-circuits OPTIONS preflights before rate limits
 *   4. better-auth    — owns its own rate-limit bucket on /api/auth/* (see
 *                       `modules/auth/better-auth.ts`). The global limiter
 *                       SKIPS this prefix so the two buckets do not double-
 *                       count the same IP.
 *   5. rateLimit      — applied broadly EXCEPT on /api/auth/*; per-route
 *                       limits can layer on top
 *   6. routes         — the actual handlers
 *   7. errorHandler   — wired via `app.onError`, catches anything thrown above
 *
 * Returns a configured Hono instance; the entry point decides how to serve it.
 * Tests use `app.request(...)` against this same instance with no server.
 *
 * Side effect: installs a global `BigInt.prototype.toJSON` on first call so
 * Hono's `c.json()` can serialize money (`bigint`) values per ADR-0007. The
 * helper is idempotent.
 */
import { Hono } from "hono";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { buildRoutes } from "./routes/index.js";
import { setupOpenApi } from "./lib/openapi.js";
import { installBigIntJsonSerializer } from "./lib/json.js";
import { getAuth } from "./modules/auth/index.js";
import type { AppBindings } from "./lib/types.js";

export function createApp(): Hono<AppBindings> {
  installBigIntJsonSerializer();

  const app = new Hono<AppBindings>();

  app.use("*", requestId());
  app.use("*", requestLogger());
  app.use("*", corsMiddleware());

  // Better Auth handler at /api/auth/*. Better Auth's own rate-limiter is
  // configured in `modules/auth/better-auth.ts` (with per-route windows
  // for sign-in/forget-password/reset-password); the global limiter below
  // EXCLUDES this prefix so we do not run two competing buckets on the
  // same key.
  //
  // The handler reads the request and writes its own response; we delegate
  // by handing Better Auth the raw `Request` and returning the `Response`
  // it produces. Hono's `app.all("/api/auth/*", ...)` is the framework-
  // recommended mount style.
  app.all("/api/auth/*", async (c) => {
    const auth = getAuth();
    return auth.handler(c.req.raw);
  });

  // Apply the global limiter to everything OUTSIDE /api/auth/*. We pass the
  // built middleware through a thin gate that short-circuits on the auth
  // prefix — a wildcard mount with manual exclusion (rather than separate
  // `app.use()` calls per non-auth prefix) keeps every other route covered
  // by default, including future modules.
  const globalLimiter = rateLimit();
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/")) {
      await next();
      return;
    }
    await globalLimiter(c, next);
  });

  setupOpenApi(app);
  app.route("/", buildRoutes());

  app.onError(errorHandler);

  return app;
}
