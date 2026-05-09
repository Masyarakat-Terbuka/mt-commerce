# ADR-0019: Idempotency-Key middleware paired with row-level dedup

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** mt-commerce maintainers

---

## Context

Mutating endpoints in commerce are dangerous on retry. A `POST /checkout/{id}/complete` that times out after the order has been written but before the response reaches the buyer leaves the buyer's client unsure: did the order go through? The natural client behaviour — retry — must not produce two orders.

The same problem appears at every mutating boundary that has a side-effect: payment initiation (don't charge twice), refund (don't refund twice), capture (don't capture twice), inventory adjustment (don't decrement twice). And in v0.1 the api also has to defend against retries the buyer's client did not initiate — Midtrans webhooks redeliver on transient failures, and the platform must not transition the order twice.

Two distinct retry shapes:

**Client retries.** The buyer's checkout client (the storefront island, an SDK consumer) sends the same request twice because the first response was lost. The retry carries the same `Idempotency-Key` HTTP header. The api should return the same response as the first attempt without redoing the side-effect.

**Provider redeliveries.** Midtrans posts the same webhook twice because it didn't receive our 2xx in time. The webhook body carries a provider transaction id; the platform should ignore the second delivery without re-transitioning the payment.

The two shapes share an "operation must be exactly once" requirement but the keying is different: client retries dedupe on a key the client supplies; provider redeliveries dedupe on a key the provider supplies.

The reference for the wire shape is [Stripe's Idempotency-Key contract](https://stripe.com/docs/api/idempotent_requests). Same client, same key, same request → same response. Same client, same key, different request → reject.

---

## Decision

mt-commerce uses **two layers of idempotency** working in concert:

### Layer 1 — HTTP middleware (`requireIdempotencyKey`)

A Hono middleware mounted per route. It reads the `Idempotency-Key` header, hashes the raw body to a `request_hash`, and uses the `idempotency_keys` table as a single point of serialization:

1. **Pre-flight INSERT** of an "in-flight" sentinel row (`status = 0`). The unique constraint on `key` is the lock — concurrent first-requests race the INSERT; the loser polls briefly and either reads the winner's response or times out as `409 idempotency_key_in_flight`.
2. **Run the handler.**
3. On 2xx — UPDATE the row with the real status and the JSON response body. On non-2xx or a thrown error — DELETE the sentinel so the failed call remains retryable. (A 500 must not freeze the key.)
4. **Replay** (key already stored with a real response): same `request_hash` → return the stored `(status, body)` without rerunning the handler. Different `request_hash` → `409 idempotency_key_reuse`.

The PK is `sha256(scope || ":" || key)`, so `Idempotency-Key: abc` for `checkout.complete` and for `payment.refund` do not collide. The route declares its scope: `requireIdempotencyKey({ scope: "checkout.complete" })`.

The middleware stores `(method, status, JSON body, request_hash)`. Headers other than `content-type` are not replayed — the stored contract is enough for the platform's mutating endpoints, and the limit keeps the row size bounded.

### Layer 2 — service-level dedup columns

Per-domain unique columns on the row that gets created. The two carrying weight in v0.1:

- **`payments.idempotency_key`** — the storefront's `initiate` call passes a key. Two `initiate` calls with the same key against the same order short-circuit to the existing payment row at the service layer (under transaction). The DB unique constraint is the backstop.
- **`refunds`** keyed off the same idempotency key on the platform side, forwarded to Midtrans as `refund_key` so the upstream provider also dedupes. Two retries → one refund on our row, one refund on Midtrans.

These columns are independent of the HTTP middleware. A caller can hit `payments.initiate` without going through the middleware (an internal cron, a background reconciliation) and the row-level dedup still holds.

### Webhook dedup is a different mechanism

Provider webhooks don't carry an `Idempotency-Key`; they carry a `(providerRef, status)` tuple that uniquely identifies an event. The webhook handler dedupes on `(providerRef, status)` at the data layer (the canonical projection from the verified payload) — not via the middleware. ADR-0012 captures the canonical webhook shape; this ADR records why the `Idempotency-Key` middleware does not also cover it.

---

## Consequences

### Positive

A single store, a single contract. Every protected route shares one table, one middleware, one wire shape. An operator inspecting "did this request already run?" runs a normal `SELECT` on `idempotency_keys` keyed by `sha256(scope || ":" || key)`.

The middleware is opt-in. Routes that don't need the guarantee don't pay the storage cost or the pre-flight-INSERT round trip. Mounting it where it doesn't belong is a routing mistake, not a silent slowdown.

The two layers cover different failure modes and work even when one is bypassed. A direct call to `paymentsService.initiate` from the reconciliation cron (no HTTP, no middleware) still cannot create two payment rows for the same idempotency key. An HTTP retry that arrives before the first request finished still cannot run the handler twice.

The pre-flight INSERT is the lock. We considered an advisory lock and a serializable transaction; the unique-constraint pattern is simpler, has no held-lock semantics to reason about, and is the tactic Stripe documents. The blocked retry polls briefly (≤ 5s) and either gets the winner's response or surfaces a clean 409.

The middleware also normalises error semantics. Retrying the same request after a 500 is correct (the sentinel was deleted). Retrying with the same key but a different body is wrong, and the response says exactly that — `409 idempotency_key_reuse` with a `details.code` so the client can react.

### Negative

Two layers means two places to check when something goes wrong. A "the second request returned 409 instead of replaying" debugging session has to verify both the middleware's row-state and the service's dedup column. The error codes (`idempotency_key_required`, `idempotency_key_reuse`, `idempotency_key_in_flight`) help, but the diagnostic is two-step.

The middleware stores the response body as JSON. Endpoints that need to return non-JSON (a CSV download, a PDF) cannot use it. v0.1 has no such mutating endpoint; future ones will need either a JSON-summary response that the client can re-fetch the artifact from, or a different middleware.

TTL is out of scope for v0.1. The `idempotency_keys` table grows monotonically. A future cleanup job removes rows older than 24h. Until that lands, the table will grow at the rate of mutating-endpoint requests; on a small merchant this is bounded but unbounded over years.

The body hash is a SHA-256 over the raw bytes. A client that retries with a re-serialized body (different key order, different whitespace) gets `409 idempotency_key_reuse` even though the semantic content is the same. We document the canonical-form expectation in the API reference; the alternative (parsing the JSON before hashing) trades one false-positive class for a different one (numeric precision, key ordering) and adds CPU per request.

The middleware reconstructs `Response` from `(status, JSON body)`. It does not replay arbitrary headers — `Set-Cookie`, custom rate-limit headers, etc., are not stored. Today's mutating endpoints don't need them; if a future one does, the middleware needs an extension.

---

## What this module does NOT do

- **Cross-tenant scoping.** mt-commerce is single-tenant per deployment (see ADR-0016). The middleware does not key on a tenant id; if multi-tenancy lands the scope-prefix becomes `tenantId:scope:key`.
- **Per-customer scoping for guest carts.** A guest's `Idempotency-Key: abc` and a logged-in customer's `Idempotency-Key: abc` against `checkout.complete` collide. We accept this — the key is opaque and the client should mint UUIDs.
- **Auto-mounted on every POST.** Operators sometimes ask "shouldn't every POST be idempotent?" The answer is no — `POST /products` for create is naturally non-idempotent (each call yields a new resource); making it idempotent would force every admin client to mint a key for every save click. The middleware is mounted where the _side-effect_ must be exactly-once, not where the verb happens to be POST.
- **Replay across deployments.** The store is a Postgres table local to the deployment. A blue/green swap that sends the retry to the new deployment and reads the old deployment's row works only because they share the database. A multi-region deployment would need a different lock primitive.

---

## Alternatives considered

### Service-level dedup only

Would mean every protected handler does its own "have I seen this key?" check against its own table. Considered and rejected because:

- Different services would re-implement the same race-resolution and replay logic. We saw early sketches diverge on whether to throw, return 200 with the cached body, or 409.
- The "replay returns the same response" requirement is not just "create idempotently" — the SAME response, byte-for-byte. That can only be done by storing the response, which lives outside the domain table. A central middleware is the right place for that.

### A Redis-backed idempotency store

Faster than Postgres, but introduces a second source of truth that can disagree with the database under partition. The session store and the rate-limit store both live in Redis; idempotency is the load-bearing one and we want it in the same transactional fate as the order it protects. Postgres is the right choice.

### A library (e.g. `express-idempotency`, Stripe's reference)

Considered. Rejected because the api is Hono and the existing libraries lean toward Express. The implementation is small enough (≈300 lines including the test seam) to own.

### Drop the body hash; trust the key alone

The Stripe contract requires the body hash. Without it, a client that reuses a key for a different request (deliberately or by mistake) silently gets the cached response — the worst possible failure mode. We keep the hash.

### Embed the in-flight wait in the handler

Instead of a sentinel row, we considered making the handler block on a Postgres advisory lock. The lock-held semantics across handler errors and timeouts were thornier than the unique-constraint pattern, and an advisory lock named after the key would not survive a connection drop. The sentinel-row approach is simpler.

---

## Related

- [ADR-0011](./0011-audit-log.md) — every protected mutation is audited; the audit row carries the idempotency key when present so operators can correlate.
- [ADR-0012](./0012-payment-provider-interface.md) — webhook dedup uses `(providerRef, status)`, not this middleware.
- `apps/api/src/middleware/idempotency.ts` — the middleware.
- `apps/api/src/db/schema/idempotency.ts` — the table.
- `apps/api/src/modules/payments/service.ts` — `initiate` carries the row-level `idempotency_key` column; the same key is forwarded as `refund_key` to Midtrans.
- `apps/api/src/modules/checkout/routes.ts` — the canonical example of `requireIdempotencyKey({ scope: "checkout.complete" })`.
