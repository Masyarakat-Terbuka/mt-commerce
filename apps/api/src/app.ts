/**
 * Hono app factory.
 *
 * Middleware order is deliberate:
 *   1. requestId    — every other layer references it for correlation
 *   2. logger       — needs the request ID; emits the request line on completion
 *   3. cors         — short-circuits OPTIONS preflights before rate limits
 *   4. rateLimit    — applied broadly; per-route limits can layer on top
 *   5. routes       — the actual handlers
 *   6. errorHandler — wired via `app.onError`, catches anything thrown above
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
import type { AppBindings } from "./lib/types.js";

export function createApp(): Hono<AppBindings> {
  installBigIntJsonSerializer();

  const app = new Hono<AppBindings>();

  app.use("*", requestId());
  app.use("*", requestLogger());
  app.use("*", corsMiddleware());
  app.use("*", rateLimit());

  setupOpenApi(app);
  app.route("/", buildRoutes());

  app.onError(errorHandler);

  return app;
}
