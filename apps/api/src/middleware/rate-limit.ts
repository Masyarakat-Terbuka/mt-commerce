/**
 * Basic in-memory rate limiter.
 *
 * Token-bucket-style sliding window keyed by a client identifier. Buckets are
 * stored in a `Map` capped at `maxBuckets` entries — when the cap is reached
 * the oldest entry (insertion order) is evicted before a new one is inserted.
 * The cap defends against memory growth from a flood of distinct IPs.
 *
 * Client IP resolution follows `TRUST_PROXY`:
 *   - When `TRUST_PROXY=true`, the leftmost `X-Forwarded-For` value is used.
 *     This is correct only when the API sits behind a reverse proxy that
 *     overwrites or sanitizes the header. In any other configuration the
 *     header is attacker-controlled and must not be trusted.
 *   - When `TRUST_PROXY=false`, the IP comes from the Bun connection (via
 *     `getConnInfo`), which reads `server.requestIP(req)` under the hood.
 *
 * TODO(production): swap in a Redis-backed limiter that survives restarts and
 * is shared across processes. The interface here is intentionally close to
 * what a Redis implementation will provide.
 */
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { RateLimitError } from "../lib/errors.js";
import { env } from "../lib/env.js";
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
  /** Maximum number of buckets retained in memory. Oldest is evicted. */
  maxBuckets: number;
  /** Override the key extractor. Defaults to client IP. */
  keyFn?: (c: Parameters<MiddlewareHandler<AppBindings>>[0]) => string;
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  windowMs: 60_000,
  max: 120,
  maxBuckets: 50_000,
};

/**
 * Resolve a client identifier for rate-limit bucketing. Prefers a trusted
 * forwarded header when configured, falls back to the connection-level IP,
 * and finally to a constant string when nothing is available (in which case
 * traffic from unknown sources buckets together — the safer default).
 */
function defaultKeyFn(
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): string {
  if (env.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp;
  }

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // `getConnInfo` is a no-op outside of Bun (e.g. in `app.request(...)`
    // tests). Fall through to the unknown bucket.
  }

  return "unknown";
}

export function rateLimit(
  options: Partial<RateLimitOptions> = {},
): MiddlewareHandler<AppBindings> {
  const opts: RateLimitOptions = { ...DEFAULT_OPTIONS, ...options };
  // `Map` preserves insertion order, so the first key returned by an
  // iterator is the oldest entry. We exploit that for FIFO eviction below.
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? defaultKeyFn;

  return async (c, next) => {
    const now = Date.now();
    const key = keyFn(c);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Evict before inserting so the cap is respected even when the same
      // call also bumps an existing key.
      if (!buckets.has(key) && buckets.size >= opts.maxBuckets) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
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
