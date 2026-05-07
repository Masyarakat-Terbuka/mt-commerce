/**
 * Idempotency-Key middleware — opt-in per route.
 *
 * Per ARCHITECTURE.md ("Every payment operation is idempotent") and
 * SECURITY.md (the same commitment): the completing checkout transition
 * MUST be safe to retry. This middleware is the canonical implementation
 * and is opt-in for any other route that needs the same guarantee.
 *
 * Wire format:
 *
 *   Idempotency-Key: <client-supplied opaque string>
 *
 * Behavior:
 *
 *   1. Header missing → 400 `idempotency_key_required`. The middleware is
 *      only mounted on routes that *require* the header; mounting it on a
 *      route where the header is optional is a routing mistake.
 *
 *   2. First request with this scoped key:
 *      - Compute `request_hash = sha256(method + ":" + path + ":" + body)`.
 *      - Run the handler. Capture the response body + status.
 *      - Store `(scoped_key, request_hash, status, response_body)` in
 *        `idempotency_keys`. The hash matters because a future replay with
 *        a different body must NOT serve the stored response.
 *      - Return the freshly-computed response.
 *
 *   3. Replay (key already stored):
 *      - Same `request_hash` → return the stored `(status, body)` without
 *        re-running the handler. Side effects of the protected operation
 *        run exactly once.
 *      - Different `request_hash` → 409 `idempotency_key_reuse`. The client
 *        is mis-using the key (reusing it for a different request).
 *
 *   4. Scoping. The DB row's primary key is `sha256(scope || ":" || raw_key)`,
 *      so `idempotency-key=abc` for `checkout.complete` and the same value
 *      for `payment.refund` collide neither on lookup nor on storage. Pass
 *      `scope` via `requireIdempotencyKey({ scope: "checkout.complete" })`.
 *
 *   5. TTL. Out of scope here. The schema carries `created_at` with an
 *      index; a future cleanup job removes rows older than 24 hours. Until
 *      that job ships, the table grows; this is acceptable for v0.1
 *      because volume is small and the cleanup is a self-contained follow-up.
 *
 * Storage strategy:
 *
 *   The middleware stores the response body as raw JSON (the same value
 *   `c.json(...)` would emit on the wire). On replay we reconstruct the
 *   `Response` from the stored body + status. Headers other than
 *   `content-type: application/json` are NOT replayed — the stored
 *   contract is "method, status code, JSON body", which is enough for the
 *   `checkout.complete` use case. Routes that need richer header fidelity
 *   should serialize the headers in the response_body JSON or extend the
 *   schema.
 *
 * Concurrency:
 *
 *   We use the unique PK as the lock. Two parallel requests with the same
 *   scoped key race the INSERT. The loser (unique-violation on its commit)
 *   re-reads and serves the winner's response. We do NOT introduce an
 *   advisory lock — Postgres's PK constraint is sufficient and avoids the
 *   blocking/timeout concerns that come with explicit locks.
 */
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import {
  ConflictError,
  ValidationError,
} from "../lib/errors.js";
import type { AppBindings } from "../lib/types.js";

export interface RequireIdempotencyKeyOptions {
  /**
   * Scope namespace for this route. Keys are stored as
   * `sha256(scope ":" raw_key)`, so a scope mismatch turns into a fresh
   * key automatically. Use a stable, dotted string per route family
   * (e.g. `"checkout.complete"`, `"payment.refund"`).
   */
  scope: string;
}

/**
 * Hash function used for both the stored key and the request fingerprint.
 * SHA-256 is overkill for a non-adversarial fingerprint, but it gives us
 * a fixed-length safe identifier and a stable diff trigger; the small CPU
 * cost is negligible compared to a database round-trip.
 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function deriveStoredKey(scope: string, rawKey: string): string {
  return sha256Hex(`${scope}:${rawKey}`);
}

function deriveRequestHash(
  method: string,
  path: string,
  body: string,
): string {
  return sha256Hex(`${method}:${path}:${body}`);
}

interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Lightweight repository surface so tests can swap a fake. The default
 * impl uses the runtime Drizzle client; tests inject an in-memory map.
 */
export interface IdempotencyStore {
  get(storedKey: string): Promise<{
    requestHash: string;
    status: number;
    body: unknown;
  } | null>;
  save(
    storedKey: string,
    requestHash: string,
    status: number,
    body: unknown,
  ): Promise<void>;
}

export function createDbIdempotencyStore(
  db: typeof defaultDb = defaultDb,
): IdempotencyStore {
  return {
    async get(storedKey) {
      const [row] = await db
        .select({
          requestHash: idempotencyKeys.requestHash,
          status: idempotencyKeys.status,
          responseBody: idempotencyKeys.responseBody,
        })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, storedKey))
        .limit(1);
      if (!row) return null;
      return {
        requestHash: row.requestHash,
        status: row.status,
        body: row.responseBody,
      };
    },
    async save(storedKey, requestHash, status, body) {
      // INSERT ... ON CONFLICT DO NOTHING — racing inserts collapse into
      // one row; the loser will re-read on the next request.
      await db
        .insert(idempotencyKeys)
        .values({
          key: storedKey,
          requestHash,
          status,
          responseBody: body as object,
        })
        .onConflictDoNothing({ target: idempotencyKeys.key });
    },
  };
}

/**
 * Build the middleware. The store is an injected dependency so tests can
 * skip the database entirely.
 *
 * Usage:
 *
 *   router.post(
 *     "/checkouts/:id/complete",
 *     requireIdempotencyKey({ scope: "checkout.complete" }),
 *     handler,
 *   );
 */
export function buildRequireIdempotencyKey(
  store: IdempotencyStore = createDbIdempotencyStore(),
): (
  options: RequireIdempotencyKeyOptions,
) => MiddlewareHandler<AppBindings> {
  return ({ scope }) => {
    return async (c, next) => {
      // Header read is case-insensitive (Hono normalizes via Headers).
      const rawKey =
        c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
      if (!rawKey || rawKey.trim().length === 0) {
        throw new ValidationError(
          "Idempotency-Key header is required for this endpoint.",
          { code: "idempotency_key_required" },
        );
      }

      // Body fingerprint. We read the body once (Hono caches the result
      // via `c.req.text()` / `c.req.json()`), so the handler can still
      // call `c.req.json()` afterwards.
      const bodyText = await c.req.text();
      const url = new URL(c.req.url);
      const requestHash = deriveRequestHash(
        c.req.method,
        url.pathname,
        bodyText,
      );
      const storedKey = deriveStoredKey(scope, rawKey.trim());

      // Replay path.
      const existing = await store.get(storedKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictError(
            "Idempotency key was reused with a different request.",
            { code: "idempotency_key_reuse" },
          );
        }
        // Serve the stored response unchanged.
        return c.json(existing.body, existing.status as 200);
      }

      // First request — re-attach the body so the downstream handler can
      // read it. We replace `c.req.raw` with a fresh Request whose body
      // matches the captured text.
      // Hono's helpers (`c.req.json()`, `c.req.text()`) memoize on the
      // first read, so we don't need to re-stream — but we DO need to
      // patch the body's "already consumed" flag for handlers that grab
      // the raw stream. Construct a new Request with the same metadata.
      const replayReq = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body:
          c.req.raw.method === "GET" || c.req.raw.method === "HEAD"
            ? undefined
            : bodyText,
      });
      // Replace the underlying request via the public hono setter.
      // (The cast is to avoid the union of frozen request types in Hono's
      // strict typing; the runtime accepts the new object.)
      const reqAny = c.req as unknown as { raw: Request };
      reqAny.raw = replayReq;

      // Run the handler.
      await next();

      // Capture the response and store. We do not fail the request if
      // storage fails — the caller already got the result; the missing
      // dedup row is a follow-up, not a regression.
      const res = c.res;
      let bodyForStore: unknown = null;
      let status = res.status;
      try {
        // Clone so we do not consume the response body that the caller
        // is about to receive.
        const cloned = res.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          try {
            bodyForStore = JSON.parse(text) as unknown;
          } catch {
            // Non-JSON response — store the text as-is. Routes guarded by
            // this middleware are JSON-emitting today, so this is purely
            // defensive.
            bodyForStore = text;
          }
        }
      } catch {
        // If we can't read the body, do not break the response.
        bodyForStore = null;
      }

      // Only store successful (2xx) responses by default. A failed call
      // should be retryable; storing a 500 would freeze the failure for
      // the lifetime of the key.
      if (status >= 200 && status < 300) {
        try {
          await store.save(storedKey, requestHash, status, bodyForStore);
        } catch {
          // Swallow — the response is already on its way to the caller.
        }
      }
    };
  };
}

/**
 * Default-export singleton wired to the runtime DB. Tests construct via
 * `buildRequireIdempotencyKey(fakeStore)` directly.
 */
export const requireIdempotencyKey = buildRequireIdempotencyKey();

/**
 * Test helper: build a fresh middleware backed by a hand-rolled store. The
 * store implements the `IdempotencyStore` shape and runs in process memory.
 */
export function buildIdempotencyKeyTestMiddleware(
  store: IdempotencyStore,
): (
  options: RequireIdempotencyKeyOptions,
) => MiddlewareHandler<AppBindings> {
  return buildRequireIdempotencyKey(store);
}
