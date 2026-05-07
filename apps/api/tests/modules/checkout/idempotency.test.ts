/**
 * Idempotency-Key middleware — unit tests with an in-memory store.
 *
 * The middleware factory accepts an injected `IdempotencyStore`, so we
 * skip the database and assert the four documented cases:
 *
 *   1. Missing key → 400 `idempotency_key_required`.
 *   2. First key → handler runs, response stored.
 *   3. Replay same key + body → stored response returned, handler is
 *      NOT re-invoked.
 *   4. Replay same key + DIFFERENT body → 409 `idempotency_key_reuse`.
 *   5. Same raw key under DIFFERENT scope → fresh insert, handler runs
 *      twice (the scope is mixed into the stored key).
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import {
  buildIdempotencyKeyTestMiddleware,
  type IdempotencyStore,
} from "../../../src/middleware/idempotency.js";
import type { AppBindings } from "../../../src/lib/types.js";

installBigIntJsonSerializer();

function createMemoryStore(): IdempotencyStore {
  const map = new Map<
    string,
    { requestHash: string; status: number; body: unknown }
  >();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async save(key, requestHash, status, body) {
      // Mirror the DB's "ON CONFLICT DO NOTHING" — first writer wins.
      if (!map.has(key)) {
        map.set(key, { requestHash, status, body });
      }
    },
  };
}

function buildApp(
  store: IdempotencyStore,
  scope: string,
  handler: ReturnType<typeof vi.fn>,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const requireIdempotencyKey = buildIdempotencyKeyTestMiddleware(store);
  app.post(
    "/test",
    requireIdempotencyKey({ scope }),
    async (c) => {
      handler();
      const body = await c.req.json().catch(() => ({}));
      return c.json({ ok: true, echo: body, n: handler.mock.calls.length });
    },
  );
  app.onError(errorHandler);
  return app;
}

describe("idempotency middleware", () => {
  it("rejects requests without the Idempotency-Key header (400)", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { code?: string } } };
    expect(body.error.details.code).toBe("idempotency_key_required");
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler once and stores the response on the first call", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler);
    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; n: number };
    expect(body.ok).toBe(true);
    expect(body.n).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the stored response on a same-body retry without re-invoking the handler", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler);
    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      body: JSON.stringify({ x: 1 }),
    } as const;

    const first = await app.request("/test", opts);
    const firstBody = await first.json();

    const second = await app.request("/test", opts);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns 409 idempotency_key_reuse when the body differs", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler);
    await app.request("/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      body: JSON.stringify({ x: 1 }),
    });
    const reuse = await app.request("/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      body: JSON.stringify({ x: 2 }),
    });
    expect(reuse.status).toBe(409);
    const body = (await reuse.json()) as { error: { code: string; details: { code?: string } } };
    expect(body.error.details.code).toBe("idempotency_key_reuse");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats the same raw key under a different scope as a fresh request", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();
    const appA = buildApp(store, "scope.a", handler);
    const appB = buildApp(store, "scope.b", handler);

    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "shared-key",
      },
      body: JSON.stringify({ x: 1 }),
    } as const;

    const a = await appA.request("/test", opts);
    expect(a.status).toBe(200);
    const b = await appB.request("/test", opts);
    expect(b.status).toBe(200);

    // Both invocations ran — the scope mix-in derives different stored
    // keys, so the second request misses the cache.
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
