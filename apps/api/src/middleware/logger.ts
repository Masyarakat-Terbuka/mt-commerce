/**
 * Per-request structured logging middleware.
 *
 * Builds a child logger bound to the request ID and stores it on the context.
 * Routes and services should pull `c.get("logger")` rather than importing the
 * top-level logger directly, so every log line carries the request ID.
 *
 * One log line per completed request — emitted *after* `next()` resolves,
 * so the recorded status reflects what the client actually received. Error
 * paths are logged by `app.onError`; we let the throw propagate without
 * catching it here, which means failed requests are logged exactly once
 * (by the error handler) and successful requests are logged exactly once
 * (here). Honors the no-double-log promise stated in the file header.
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
    // Intentionally no try/catch: when `next()` throws, control returns to
    // Hono's compose layer, which dispatches the error to `app.onError`. The
    // error handler emits the log line for that request, so we skip the
    // success log here.
    await next();

    // After `next()` returns, `c.res` is the final response. Status, headers,
    // and body have all been settled by upstream middleware and the route.
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
