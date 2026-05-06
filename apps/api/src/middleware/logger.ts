/**
 * Per-request structured logging middleware.
 *
 * Builds a child logger bound to the request ID and stores it on the context.
 * Routes and services should pull `c.get("logger")` rather than importing the
 * top-level logger directly, so every log line carries the request ID.
 *
 * Emits one log line per completed request with method, path, status, and
 * duration in milliseconds. Errors are logged by the error-handler middleware,
 * not here, so we do not double-log.
 */
import type { MiddlewareHandler } from "hono";
import { logger as rootLogger } from "../lib/logger.js";
import type { AppBindings } from "../lib/types.js";

export function requestLogger(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const requestId = c.get("requestId");
    const log = rootLogger.child({ requestId, module: "http" });
    c.set("logger", log);

    const start = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - start);

    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      },
      "request",
    );
  };
}
