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
 * Behavior (high level):
 *
 *   1. Header missing → 400 `idempotency_key_required`. The middleware is
 *      only mounted on routes that *require* the header; mounting it on a
 *      route where the header is optional is a routing mistake.
 *
 *   2. PRE-FLIGHT INSERT. Before running the handler we INSERT an
 *      "in-flight" sentinel row with `status = 0` (real HTTP statuses
 *      start at 100, so `0` cannot collide). The sentinel uses the
 *      unique constraint on `key` to serialise concurrent first-requests:
 *
 *        - INSERT succeeds → we are the first request. Run the handler.
 *        - INSERT fails with unique-violation → another request is
 *          already running OR has finished. Inspect the existing row:
 *            - status is a real status (>= 100): replay path — return
 *              the stored response (after request_hash check).
 *            - status is 0 (still in-flight): poll briefly until it
 *              transitions, OR time out → 409 `idempotency_key_in_flight`.
 *
 *   3. After the handler completes:
 *      - 2xx → UPDATE the row with the real status + body.
 *      - non-2xx (or thrown error) → DELETE the sentinel so the failed
 *        call remains retryable. SECURITY.md requires this — a 500 from
 *        the handler should not freeze the key against retry.
 *
 *   4. Replay (key already stored with a real response):
 *      - Same `request_hash` → return the stored `(status, body)` without
 *        re-running the handler. Side effects of the protected operation
 *        run exactly once.
 *      - Different `request_hash` → 409 `idempotency_key_reuse`. The client
 *        is mis-using the key (reusing it for a different request).
 *
 *   5. Scoping. The DB row's primary key is `sha256(scope || ":" || raw_key)`,
 *      so `idempotency-key=abc` for `checkout.complete` and the same value
 *      for `payment.refund` collide neither on lookup nor on storage. Pass
 *      `scope` via `requireIdempotencyKey({ scope: "checkout.complete" })`.
 *
 *   6. TTL. Out of scope here. The schema carries `created_at` with an
 *      index; a future cleanup job removes rows older than 24 hours.
 *
 * Storage strategy:
 *
 *   The middleware stores the response body as raw JSON (the same value
 *   `c.json(...)` would emit on the wire). On replay we reconstruct the
 *   `Response` from the stored body + status. Headers other than
 *   `content-type: application/json` are NOT replayed — the stored
 *   contract is "method, status code, JSON body", which is enough for
 *   the `checkout.complete` use case.
 *
 *   Empty / 204 bodies are stored as `response_body IS NULL`; the
 *   middleware reconstructs an empty body in that case. The schema's
 *   `response_body` column is nullable for exactly this reason.
 *
 * Concurrency:
 *
 *   The unique constraint on `key` is the lock. Two parallel first-
 *   requests race the pre-flight INSERT; the loser blocks on `store.get`
 *   polling until the winner finalises. We do NOT introduce an advisory
 *   lock — the unique-violation path plus a bounded poll is sufficient
 *   and avoids the long-held-lock concerns that come with explicit locks.
 */
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import {
  ConflictError,
  ValidationError,
} from "../lib/errors.js";
import type { AppBindings } from "../lib/types.js";

/**
 * Reserved status sentinel. Inserted into `idempotency_keys.status` while
 * a request is in-flight. Real HTTP responses always have status >= 100,
 * so this cannot collide with a stored real response.
 */
export const IDEMPOTENCY_STATUS_IN_FLIGHT = 0;

/**
 * Default upper bound on the poll-while-in-flight wait. Concurrent
 * first-requests block here while the winner runs the handler. 5 seconds
 * is the SECURITY.md recommendation; keep this generous-enough that a
 * normal handler finishes inside the window but bounded so a hung handler
 * cannot pin a connection forever.
 */
const POLL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

export interface RequireIdempotencyKeyOptions {
  /**
   * Scope namespace for this route. Keys are stored as
   * `sha256(scope ":" raw_key)`, so a scope mismatch turns into a fresh
   * key automatically. Use a stable, dotted string per route family
   * (e.g. `"checkout.complete"`, `"payment.refund"`).
   */
  scope: string;
  /** Test seam — override the poll budget. Production callers omit this. */
  pollTimeoutMs?: number;
  /** Test seam — override the poll interval. Production callers omit this. */
  pollIntervalMs?: number;
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

interface StoredRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

/**
 * Result of attempting to claim an idempotency key for a fresh request.
 *  - `claimed`: we INSERTed the in-flight sentinel; the caller should run
 *    the handler and then `finalize` (success) or `releaseInFlight`
 *    (failure).
 *  - `existing`: another request already owns the key. The caller should
 *    inspect `record.status`: if it's `IDEMPOTENCY_STATUS_IN_FLIGHT` the
 *    other request is still running (poll); otherwise serve the stored
 *    response (after request_hash check).
 */
export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "existing"; record: StoredRecord };

/**
 * Lightweight repository surface so tests can swap a fake. The default
 * impl uses the runtime Drizzle client; tests inject an in-memory map.
 */
export interface IdempotencyStore {
  /**
   * Atomic "claim" attempt. INSERT the in-flight sentinel; on conflict
   * return the existing row.
   */
  claim(storedKey: string, requestHash: string): Promise<ClaimResult>;
  /**
   * Read the row for a stored key without mutating it. Used by the
   * polling path on a concurrent first-request.
   */
  get(storedKey: string): Promise<StoredRecord | null>;
  /**
   * Persist the real response (handler succeeded). Replaces the in-flight
   * sentinel; the row is now a stored response visible to future replays.
   */
  finalize(
    storedKey: string,
    requestHash: string,
    status: number,
    body: unknown,
  ): Promise<void>;
  /**
   * Remove the in-flight sentinel after a handler failure. The key is
   * now retryable. Only deletes if the row is still in_flight; an
   * already-finalised row is left alone.
   */
  releaseInFlight(storedKey: string): Promise<void>;
}

export function createDbIdempotencyStore(
  db: typeof defaultDb = defaultDb,
): IdempotencyStore {
  return {
    async claim(storedKey, requestHash) {
      // INSERT ... ON CONFLICT DO NOTHING. If the insert succeeds, we
      // own the key. If it returns nothing, another request is ahead of
      // us — re-read so the caller can decide replay vs poll.
      const inserted = await db
        .insert(idempotencyKeys)
        .values({
          key: storedKey,
          requestHash,
          status: IDEMPOTENCY_STATUS_IN_FLIGHT,
          responseBody: null,
        })
        .onConflictDoNothing({ target: idempotencyKeys.key })
        .returning({ key: idempotencyKeys.key });

      if (inserted.length > 0) {
        return { kind: "claimed" };
      }
      const existing = await this.get(storedKey);
      if (!existing) {
        // The conflict row vanished between the conflict and the re-read
        // (TTL job, manual delete). Treat as an unrecoverable race —
        // a fresh INSERT will succeed on retry.
        throw new Error(
          "idempotency: claim conflicted but row is missing on re-read",
        );
      }
      return { kind: "existing", record: existing };
    },
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
    async finalize(storedKey, requestHash, status, body) {
      // We only finalise rows we own (status = 0). A concurrent process
      // that somehow reached the same key would already have its own
      // row; we should not silently overwrite a real response.
      await db
        .update(idempotencyKeys)
        .set({
          requestHash,
          status,
          // `body` may be `null` for 204 / empty 2xx responses; the
          // jsonb column is nullable for exactly this case.
          responseBody: body as object | null,
        })
        .where(
          and(
            eq(idempotencyKeys.key, storedKey),
            eq(idempotencyKeys.status, IDEMPOTENCY_STATUS_IN_FLIGHT),
          ),
        );
    },
    async releaseInFlight(storedKey) {
      // Only delete the in-flight sentinel — never a finalised row.
      await db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.key, storedKey),
            eq(idempotencyKeys.status, IDEMPOTENCY_STATUS_IN_FLIGHT),
          ),
        );
    },
  };
}

/**
 * Reset Hono's body cache so that a downstream handler reading
 * `c.req.json()` after the middleware has consumed the body via
 * `c.req.text()` sees the fresh request rather than the stale parse
 * cached against the old `c.req.raw`. We swap `c.req.raw` to a Request
 * built from the captured body text; clearing the cache forces Hono to
 * read from the new raw on the next access. Without this, handlers that
 * call `c.req.json()` would receive the body parsed against the
 * original (now-consumed) Request — usually fine, but a surprising
 * coupling that has bitten other middlewares.
 */
function resetBodyCache(c: { req: { bodyCache: Record<string, unknown> } }): void {
  // Hono exposes `bodyCache` as a public field on HonoRequest; clear all
  // memoized parses so reads against the swapped `c.req.raw` start fresh.
  for (const key of Object.keys(c.req.bodyCache)) {
    delete c.req.bodyCache[key];
  }
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
  return ({ scope, pollTimeoutMs, pollIntervalMs }) => {
    const timeoutMs = pollTimeoutMs ?? POLL_TIMEOUT_MS;
    const intervalMs = pollIntervalMs ?? POLL_INTERVAL_MS;
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
      // call `c.req.json()` afterwards once we replace `c.req.raw`.
      const bodyText = await c.req.text();
      const url = new URL(c.req.url);
      const requestHash = deriveRequestHash(
        c.req.method,
        url.pathname,
        bodyText,
      );
      const storedKey = deriveStoredKey(scope, rawKey.trim());

      // Pre-flight claim — atomic INSERT or read-existing.
      const claim = await store.claim(storedKey, requestHash);
      if (claim.kind === "existing") {
        const settled = await waitForSettled(
          store,
          storedKey,
          claim.record,
          timeoutMs,
          intervalMs,
        );
        if (!settled) {
          // The other request is still in-flight after the budget. Do
          // NOT block the connection further; tell the caller to retry.
          throw new ConflictError(
            "An in-flight request is using this idempotency key; retry shortly.",
            { code: "idempotency_key_in_flight" },
          );
        }
        // Settled — verify the request hash matches the original
        // before serving the stored response.
        if (settled.requestHash !== requestHash) {
          throw new ConflictError(
            "Idempotency key was reused with a different request.",
            { code: "idempotency_key_reuse" },
          );
        }
        return reconstructStoredResponse(c, settled);
      }

      // First request — re-attach the body so the downstream handler can
      // read it. We replace `c.req.raw` with a fresh Request whose body
      // matches the captured text, then clear Hono's body cache so the
      // next `c.req.json()` reads from the fresh request rather than
      // the stale memoized parse against the old raw.
      const replayReq = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body:
          c.req.raw.method === "GET" || c.req.raw.method === "HEAD"
            ? undefined
            : bodyText,
      });
      const reqAny = c.req as unknown as {
        raw: Request;
        bodyCache: Record<string, unknown>;
      };
      reqAny.raw = replayReq;
      resetBodyCache(c as unknown as { req: { bodyCache: Record<string, unknown> } });

      let handlerThrew = false;
      try {
        await next();
      } catch (err) {
        handlerThrew = true;
        // Release the in-flight sentinel so a retry can claim the key.
        // Swallow the release error (we want to surface the original
        // handler error).
        await safeRelease(store, storedKey);
        throw err;
      }

      // If the handler did not throw, capture the response.
      if (handlerThrew) return;

      const res = c.res;
      const status = res.status;

      // Only store successful (2xx) responses. A failed call should be
      // retryable; storing a 500 would freeze the failure for the
      // lifetime of the key. Failures release the sentinel so a retry
      // can claim the key cleanly.
      if (status < 200 || status >= 300) {
        await safeRelease(store, storedKey);
        return;
      }

      let bodyForStore: unknown = null;
      try {
        // Clone so we do not consume the response body that the caller
        // is about to receive.
        const cloned = res.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          try {
            bodyForStore = JSON.parse(text) as unknown;
          } catch {
            // Non-JSON response — store the text as-is. Routes guarded
            // by this middleware are JSON-emitting today, so this is
            // purely defensive.
            bodyForStore = text;
          }
        }
        // Empty body (204 / 200 with no payload): leave bodyForStore
        // as null. The schema's response_body column is nullable for
        // this case; the replay path reconstructs an empty body.
      } catch {
        // If we can't read the body, fall back to null. Storing null
        // means a replay returns an empty body — strictly less correct
        // than what just went out, but better than crashing the
        // request that already succeeded.
        bodyForStore = null;
      }

      try {
        await store.finalize(storedKey, requestHash, status, bodyForStore);
      } catch {
        // Swallow — the response is already on its way to the caller;
        // a missing finalised row just means the next replay will
        // re-run the handler (the key still works).
      }
    };
  };
}

/**
 * Poll until the in-flight row settles (status changes to a real HTTP
 * status) or the budget runs out. Returns the settled record on
 * success, or null on timeout. The first record is passed in so the
 * caller can short-circuit if the row was ALREADY settled at claim time.
 */
async function waitForSettled(
  store: IdempotencyStore,
  storedKey: string,
  initial: StoredRecord,
  timeoutMs: number,
  intervalMs: number,
): Promise<StoredRecord | null> {
  if (initial.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return initial;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const current = await store.get(storedKey);
    if (!current) {
      // The owner failed and released the sentinel — treat as a
      // brand-new request from the polling caller's perspective. The
      // simplest correct response is to surface in_flight (the caller
      // retries with the same key, which will then claim afresh).
      return null;
    }
    if (current.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return current;
  }
  return null;
}

async function safeRelease(
  store: IdempotencyStore,
  storedKey: string,
): Promise<void> {
  try {
    await store.releaseInFlight(storedKey);
  } catch {
    // Nothing we can do here — the surrounding logic already lost or
    // is about to throw. The TTL job will eventually clean the row.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reconstructStoredResponse(
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  record: StoredRecord,
): Response {
  // The on-disk shape is:
  //   - `body === null` — 204 / empty body. Reconstruct as an empty body.
  //   - otherwise        — JSON body with content-type application/json.
  if (record.body === null) {
    return new Response(null, { status: record.status });
  }
  return c.json(record.body, record.status as 200);
}

/**
 * Default-export singleton wired to the runtime DB. Tests construct via
 * `buildRequireIdempotencyKey(fakeStore)` directly.
 */
export const requireIdempotencyKey = buildRequireIdempotencyKey();

/**
 * Test helper: build a fresh middleware backed by a hand-rolled store.
 * The store implements the `IdempotencyStore` shape and runs in process
 * memory.
 */
export function buildIdempotencyKeyTestMiddleware(
  store: IdempotencyStore,
): (
  options: RequireIdempotencyKeyOptions,
) => MiddlewareHandler<AppBindings> {
  return buildRequireIdempotencyKey(store);
}
