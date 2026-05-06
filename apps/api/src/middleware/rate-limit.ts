/**
 * Basic in-memory rate limiter.
 *
 * Token-bucket-style sliding window keyed by a client identifier (the IP from
 * `x-forwarded-for` or the connection's remote address). Buckets are stored in
 * a `Map`; entries expire on access.
 *
 * TODO(production): swap in a Redis-backed limiter that survives restarts and
 * is shared across processes. The in-memory variant is for development and
 * single-process deployments only. The interface here is intentionally close
 * to what a Redis implementation will provide.
 */
import type { MiddlewareHandler } from "hono";
import { RateLimitError } from "../lib/errors.js";
import type { AppBindings } from "../lib/types.js";

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per window per key. */
  max: number;
  /** Override the key extractor. Defaults to client IP. */
  keyFn?: (c: Parameters<MiddlewareHandler<AppBindings>>[0]) => string;
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  windowMs: 60_000,
  max: 120,
};

export function rateLimit(
  options: Partial<RateLimitOptions> = {},
): MiddlewareHandler<AppBindings> {
  const opts: RateLimitOptions = { ...DEFAULT_OPTIONS, ...options };
  const buckets = new Map<string, Bucket>();

  const defaultKeyFn = (
    c: Parameters<MiddlewareHandler<AppBindings>>[0],
  ): string => {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    // Fallback for environments without forwarded headers. Not all runtimes
    // expose a remote address; an empty string still buckets together which
    // is the safer default.
    return c.req.header("x-real-ip") ?? "unknown";
  };

  const keyFn = opts.keyFn ?? defaultKeyFn;

  return async (c, next) => {
    const now = Date.now();
    const key = keyFn(c);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (bucket.count > opts.max) {
      c.header("Retry-After", String(resetSeconds));
      throw new RateLimitError("Too many requests, please try again later.", {
        retryAfterSeconds: resetSeconds,
      });
    }

    await next();
  };
}
