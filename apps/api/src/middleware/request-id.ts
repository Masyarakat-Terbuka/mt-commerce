/**
 * Request ID middleware.
 *
 * Assigns a ULID to every request, exposes it on the Hono context as
 * `requestId`, and echoes it on the response as `x-request-id`.
 *
 * If the client sends an `x-request-id` header we trust and propagate it. This
 * lets a frontend or a load balancer correlate logs across hops.
 */
import type { MiddlewareHandler } from "hono";
import { rawUlid } from "../lib/ulid.js";
import type { AppBindings } from "../lib/types.js";

const HEADER = "x-request-id";

// Reasonable upper bound for a propagated ID (matches typical tracing IDs).
const MAX_INCOMING_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function requestId(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const incoming = c.req.header(HEADER);
    const id =
      incoming && incoming.length <= MAX_INCOMING_LENGTH && ID_PATTERN.test(incoming)
        ? incoming
        : rawUlid();

    c.set("requestId", id);
    c.header(HEADER, id);
    await next();
  };
}
