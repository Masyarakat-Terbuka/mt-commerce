/**
 * Idempotency-Key middleware — unit tests with an in-memory store.
 *
 * The middleware factory accepts an injected `IdempotencyStore`, so we
 * skip the database and assert the documented cases:
 *
 *   1. Missing key → 400 `idempotency_key_required`.
 *   2. First key → handler runs, response stored.
 *   3. Replay same key + body → stored response returned, handler is
 *      NOT re-invoked.
 *   4. Replay same key + DIFFERENT body → 409 `idempotency_key_reuse`.
 *   5. Same raw key under DIFFERENT scope → fresh insert, handler runs
 *      twice (the scope is mixed into the stored key).
 *   6. Concurrent first-requests with the same key — one wins, the
 *      other polls the in-flight sentinel and serves the winner's
 *      stored response.
 *   7. In-flight timeout — when the winner never finalises within the
 *      poll budget, the loser surfaces 409 `idempotency_key_in_flight`.
 *   8. Failed handler — sentinel deleted, retry succeeds.
 *   9. 204 / empty-body 2xx — replay returns the same 204 with no body.
 *  10. Body-cache reset — handlers calling `c.req.json()` after the
 *      middleware swaps `c.req.raw` see the correct body.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import {
  IDEMPOTENCY_STATUS_IN_FLIGHT,
  buildIdempotencyKeyTestMiddleware,
  type ClaimResult,
  type IdempotencyStore,
} from "../../../src/middleware/idempotency.js";
import type { AppBindings } from "../../../src/lib/types.js";

installBigIntJsonSerializer();

interface MemoryRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

interface MemoryStore extends IdempotencyStore {
  /** Test introspection — exposes the underlying map for assertions. */
  readonly map: Map<string, MemoryRecord>;
}

function createMemoryStore(): MemoryStore {
  const map = new Map<string, MemoryRecord>();
  const store: MemoryStore = {
    map,
    async claim(key, requestHash): Promise<ClaimResult> {
      if (!map.has(key)) {
        map.set(key, {
          requestHash,
          status: IDEMPOTENCY_STATUS_IN_FLIGHT,
          body: null,
        });
        return { kind: "claimed" };
      }
      const existing = map.get(key)!;
      return { kind: "existing", record: { ...existing } };
    },
    async get(key) {
      const row = map.get(key);
      return row ? { ...row } : null;
    },
    async finalize(key, requestHash, status, body) {
      const existing = map.get(key);
      if (!existing) return;
      if (existing.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return;
      map.set(key, { requestHash, status, body });
    },
    async releaseInFlight(key) {
      const existing = map.get(key);
      if (!existing) return;
      if (existing.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return;
      map.delete(key);
    },
  };
  return store;
}

function buildApp(
  store: IdempotencyStore,
  scope: string,
  handler: ReturnType<typeof vi.fn>,
  pollOpts: { pollTimeoutMs?: number; pollIntervalMs?: number } = {},
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const requireIdempotencyKey = buildIdempotencyKeyTestMiddleware(store);
  app.post(
    "/test",
    requireIdempotencyKey({ scope, ...pollOpts }),
    async (c) => {
      handler();
      const body = await c.req.json().catch(() => ({}));
      return c.json({ ok: true, echo: body, n: handler.mock.calls.length });
    },
  );
  app.onError(errorHandler);
  return app;
}

describe("idempotency middleware — basics", () => {
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
    // Sentinel was finalised — a single row remains and its status is
    // the real one.
    expect(store.map.size).toBe(1);
    const [only] = [...store.map.values()];
    expect(only!.status).toBe(200);
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

describe("idempotency middleware — concurrency & failure", () => {
  it("on concurrent first-requests, polls and returns the winner's stored response", async () => {
    // Build a store that holds the winner's `finalize` until we release
    // it, so the polling path actually exercises the in-flight branch.
    const memory = createMemoryStore();
    let resolveFinalize: (() => void) | null = null;
    const finalizeGate = new Promise<void>((resolve) => {
      resolveFinalize = resolve;
    });
    const store: IdempotencyStore = {
      claim: memory.claim.bind(memory),
      get: memory.get.bind(memory),
      releaseInFlight: memory.releaseInFlight.bind(memory),
      async finalize(key, requestHash, status, body) {
        await finalizeGate;
        await memory.finalize(key, requestHash, status, body);
      },
    };

    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler, {
      pollTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "concurrent-key",
      },
      body: JSON.stringify({ x: 7 }),
    } as const;

    // Kick off both requests in parallel. The winner's finalize is
    // gated, so the loser will hit the polling path.
    const winner = app.request("/test", opts);
    // Yield once so the winner reliably reaches the in-flight INSERT
    // before the loser starts.
    await new Promise((r) => setTimeout(r, 5));
    const loser = app.request("/test", opts);

    // After a small delay, release the winner's finalize. The loser
    // observes the settled row and serves the same response.
    setTimeout(() => resolveFinalize?.(), 50);

    const [winRes, loseRes] = await Promise.all([winner, loser]);
    expect(winRes.status).toBe(200);
    expect(loseRes.status).toBe(200);
    expect(await winRes.json()).toEqual(await loseRes.json());
    // Handler ran exactly once — the loser served the stored response.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns 409 idempotency_key_in_flight when the winner never finalises within the budget", async () => {
    // A store where `finalize` blocks forever, so the in-flight row
    // outlives the loser's poll budget.
    const memory = createMemoryStore();
    const store: IdempotencyStore = {
      claim: memory.claim.bind(memory),
      get: memory.get.bind(memory),
      releaseInFlight: memory.releaseInFlight.bind(memory),
      async finalize() {
        // Hang forever within this test — the loser must time out.
        await new Promise(() => undefined);
      },
    };

    const handler = vi.fn();
    const app = buildApp(store, "test.scope", handler, {
      pollTimeoutMs: 200,
      pollIntervalMs: 20,
    });

    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "in-flight-key",
      },
      body: JSON.stringify({ x: 1 }),
    } as const;

    // Fire the winner; do not await it (it never finishes).
    void app.request("/test", opts);
    await new Promise((r) => setTimeout(r, 5));

    const loser = await app.request("/test", opts);
    expect(loser.status).toBe(409);
    const body = (await loser.json()) as { error: { details: { code?: string } } };
    expect(body.error.details.code).toBe("idempotency_key_in_flight");
  });

  it("releases the sentinel on handler failure so retries can claim the key", async () => {
    const store = createMemoryStore();
    let attempts = 0;
    const handler = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
    });

    const app = new Hono<AppBindings>();
    const middleware = buildIdempotencyKeyTestMiddleware(store);
    app.post("/test", middleware({ scope: "test.scope" }), async (c) => {
      handler();
      return c.json({ ok: true });
    });
    app.onError(errorHandler);

    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "retry-key",
      },
      body: JSON.stringify({ x: 1 }),
    } as const;

    const fail = await app.request("/test", opts);
    expect(fail.status).toBe(500);
    // The sentinel was released — the second attempt claims afresh.
    expect(store.map.size).toBe(0);

    const ok = await app.request("/test", opts);
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("idempotency middleware — empty-body responses", () => {
  it("stores and replays a 204 / empty 2xx response", async () => {
    const store = createMemoryStore();
    const handler = vi.fn();

    const app = new Hono<AppBindings>();
    const middleware = buildIdempotencyKeyTestMiddleware(store);
    app.post("/test", middleware({ scope: "test.scope" }), (c) => {
      handler();
      return c.body(null, 204);
    });
    app.onError(errorHandler);

    const opts = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "empty-key",
      },
      body: JSON.stringify({ x: 1 }),
    } as const;

    const first = await app.request("/test", opts);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");

    // Replay returns the same 204, no body, handler not re-invoked.
    const second = await app.request("/test", opts);
    expect(second.status).toBe(204);
    expect(await second.text()).toBe("");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("idempotency middleware — body cache reset", () => {
  it("downstream c.req.json() returns the request's body after the middleware runs", async () => {
    const store = createMemoryStore();
    let observedBody: unknown = null;

    const app = new Hono<AppBindings>();
    const middleware = buildIdempotencyKeyTestMiddleware(store);
    app.post("/test", middleware({ scope: "test.scope" }), async (c) => {
      // The middleware swapped `c.req.raw` after consuming `text()`;
      // a stale body cache would surface the wrong / undefined parse.
      observedBody = await c.req.json();
      return c.json({ ok: true });
    });
    app.onError(errorHandler);

    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "body-cache",
      },
      body: JSON.stringify({ greeting: "hello", n: 42 }),
    });
    expect(res.status).toBe(200);
    expect(observedBody).toEqual({ greeting: "hello", n: 42 });
  });
});
