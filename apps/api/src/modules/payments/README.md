# Payments module

Owns the canonical financial record of every charge: the `payments`
row, its append-only `payment_attempts` log, and the seam every
provider plugin implements (`PaymentProvider`).

Per ADR-0005 no other module reads or writes payment tables directly —
cross-module callers go through `paymentService`. Per
ADR-0007 every money column is `bigint` in the smallest unit of
`currency`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table                | Purpose                                                       | ID prefix |
| -------------------- | ------------------------------------------------------------- | --------- |
| `payments`           | Canonical payment record (one per order in v0.1).             | `pay_`    |
| `payment_attempts`   | Append-only log of provider round-trips and webhook deliveries| `pat_`    |

`payments.idempotency_key` is the caller-supplied dedupe handle for
`initiate`. It is **not** the same as the HTTP-layer `idempotency_keys`
table — that one dedupes the request/response body of any
`requireIdempotencyKey`-guarded route. The column on `payments` is the
business-level "I want one payment for this order, not two." A retry
with the same key returns the existing row.

`payments.provider_ref` is nullable. We write the row before calling
the provider so an idempotent retry returns the existing row even when
the first provider call failed; the column is patched once the
provider responds.

## State machine

```
   pending ───► authorized ───► captured ───► refunded
      │             │              │
      │             ├──► failed    ├──► failed
      │             └──► cancelled └──► cancelled
      ├──► captured (capture-on-initiate providers)
      ├──► failed
      └──► cancelled
```

Allowed transitions (also pinned in `state.ts` and exhaustively
tested):

- `pending → authorized | captured | failed | cancelled`
- `authorized → captured | failed | cancelled`
- `captured → refunded | failed | cancelled`

Terminal states: `failed`, `refunded`, `cancelled`.

## Provider interface

```ts
import type { PaymentProvider } from "./modules/payments";
```

```ts
interface PaymentProvider {
  readonly code: string;
  initiate(input): Promise<InitiateResult>;
  capture(input): Promise<{ status: "captured"; rawResponse?: unknown }>;
  refund(input): Promise<{ status: "refunded"; rawResponse?: unknown }>;
  verifyWebhookSignature(input): VerifiedWebhook;
}

type InitiateResult =
  | { status: "redirect"; redirectUrl: string; providerRef: string; rawResponse?: unknown }
  | { status: "captured"; providerRef: string; rawResponse?: unknown }
  | { status: "pending"; providerRef: string; rawResponse?: unknown };
```

`initiate` returns one of three discriminated outcomes:

- `redirect` — the buyer visits `redirectUrl` (Snap, hosted-checkout
  flows). The order stays `pending_payment`; a webhook (or admin
  capture) finalises it later.
- `captured` — synchronous capture (card auth + capture in one step).
  The service transitions the order `pending_payment → paid`.
- `pending` — async settlement (offline transfer). Same handling as
  `redirect` but with no URL.

`verifyWebhookSignature` is synchronous and **throws** on any
verification failure. The service never proceeds with an unverified
payload. The return shape projects every provider's payload into a
canonical `(event, providerRef, status, rawPayload)` tuple so the
dispatch path stays provider-agnostic.

## Provider registry

A `Map<code, PaymentProvider>`:

```ts
import { paymentProviderRegistry } from "./modules/payments";

paymentProviderRegistry.register(myProvider);
```

The default singleton is pre-registered with
`InMemoryTestPaymentProvider` (code: `"in_memory_test"`). Plugins
register real providers (`midtrans`, `xendit`, ...) at startup with no
reach into module internals.

Re-registering the same code throws — operators see the conflict at
startup, not as a mysterious wrong-provider call mid-checkout.

## Service interface

```ts
import { paymentService, type PaymentService } from "./modules/payments";
```

```ts
interface PaymentService {
  initiate(input): Promise<PaymentInitiateOutcome>;
  capture(input): Promise<Payment>;
  refund(input): Promise<Payment>;
  getById(paymentId): Promise<PaymentWithAttempts | null>;
  getByOrderId(orderId): Promise<Payment | null>;
  list(query): Promise<Paginated<Payment>>;
  listAttempts(paymentId): Promise<PaymentAttempt[]>;
  handleWebhook(input): Promise<HandleWebhookResult>;
}
```

### `initiate`

1. Resolve the provider FIRST (typo on `providerCode` rejects without
   writing a row).
2. Rehydrate by `idempotencyKey` — a same-key retry returns the
   existing row's outcome.
3. Load the order (source of truth for amount/currency).
4. Inside one transaction: insert `payments` + a `pending` initiate
   attempt.
5. Call the provider OUTSIDE the transaction (no long-running HTTP
   call pinning a Postgres connection).
6. On success: persist outcome, write the success attempt, emit
   `payment.initiated` (+ `payment.captured` when sync), audit row.
7. On synchronous capture: drive the order `pending_payment → paid`.
8. On failure: write a `failure` attempt, leave the parent row
   `pending` (a fresh idempotency key can retry). Throw the original
   provider error.

### `capture`

Manual capture for authorise-then-capture providers. Idempotent: a
second call returns the same row and writes a no-op attempt.
Transitions the order to `paid` on success.

### `refund`

Full or partial. Records the partial amount on the attempt's
`requestPayload` (the parent row tracks status only in v0.1).
Transitions the order to `refunded` on success. Idempotent: a second
call returns the same row.

### `handleWebhook`

1. Provider verifies the signature against the raw body. Failure →
   `ValidationError {code:"webhook_signature_invalid"}`.
2. Look up the payment by `(provider, providerRef)`. Unknown ref →
   `{ status: "ignored" }` (a webhook may arrive before our `initiate`
   finalises; provider should NOT retry forever).
3. Record the webhook attempt + transition the payment.
4. On `captured` → drive the order to `paid`. On `refunded` → drive to
   `refunded`.

Idempotent on duplicate delivery: a second `captured` event for an
already-`captured` payment writes a fresh attempt row (audit trail) but
does NOT re-transition.

## Emitted events

| Event                    | Payload                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `payment.initiated`      | `{ paymentId, orderId, provider, outcome }`                                      |
| `payment.captured`       | `{ paymentId, orderId, provider }`                                               |
| `payment.failed`         | `{ paymentId, orderId, provider, reason }`                                       |
| `payment.refunded`       | `{ paymentId, orderId, provider }`                                               |
| `payment.status_changed` | `{ paymentId, orderId, fromStatus, toStatus }` (every change)                    |

## Routes

### Admin (`/admin/v1`) — `requireRole("owner", "admin", "staff")`

| Method | Path                          | Purpose                                                  |
| ------ | ----------------------------- | -------------------------------------------------------- |
| GET    | `/payments`                   | List with optional `?orderId=`, `?status=`, `?provider=` |
| GET    | `/payments/:id`               | Detail with full attempt history                         |
| POST   | `/payments/:id/capture`       | Idempotent (`Idempotency-Key` required). Body: `{ amount? }` |
| POST   | `/payments/:id/refund`        | Idempotent. Body: `{ amount?, reason? }`                 |

### Storefront (`/storefront/v1`)

| Method | Path                                          | Purpose                                                |
| ------ | --------------------------------------------- | ------------------------------------------------------ |
| POST   | `/checkouts/:id/payment/initiate`             | Idempotent. Body: `{ providerCode, metadata? }`        |
| GET    | `/checkouts/:id/payment`                      | Fetch the payment for this checkout                    |

The storefront resolves `checkoutId → orderId` via
`OrderService.getOrderByCheckoutId`. Bearer pattern matches checkout:
the unguessable checkout id is the auth token.

### Webhook (top-level)

| Method | Path                                  | Purpose                                                       |
| ------ | ------------------------------------- | ------------------------------------------------------------- |
| POST   | `/webhooks/payments/:providerCode`    | Generic ingress. No auth gate — the body signature IS the auth |

Returns `{ status: "accepted" | "ignored", paymentId, event }`.
`ignored` covers unknown payment refs and idempotent re-deliveries —
the provider should NOT retry. Signature failures surface as 400
`webhook_signature_invalid`.

## Idempotency

Two layers, by design:

1. **HTTP-layer** (`requireIdempotencyKey` middleware on capture /
   refund / initiate). Dedupes the request/response body — replays
   return the same JSON. Storage: the shared `idempotency_keys` table.

2. **Business-layer** (`payments.idempotency_key` UNIQUE column).
   Dedupes the `initiate` semantics — even if the HTTP request differs
   slightly, a same-key retry returns the same payment row.

The storefront `initiate` route passes the HTTP `Idempotency-Key`
header through to the service as the business-level key. A single
header satisfies both layers.

## In-memory test provider

`InMemoryTestPaymentProvider` (code: `"in_memory_test"`) is the
canonical test double. Used by integration tests and dev environments
before a real provider plugin is installed.

Test hints via `metadata.code`:

- default → `{ status: "captured" }` (happy path)
- `"TEST_PENDING_*"` → `{ status: "pending" }`
- `"TEST_REDIRECT_*"` → `{ status: "redirect", redirectUrl: "https://example.test/pay/<ref>" }`
- `"TEST_FAIL"` → throws (simulates upstream 5xx)

Webhook signing: HMAC-SHA256 of the raw body, header
`x-mt-test-signature`. Tests use `signTestWebhook(secret, body)` to
construct fixtures.

## Building a plugin provider

```ts
import { definePlugin } from "@mt-commerce/core";
import type { PaymentProvider } from "@mt-commerce/api/payments";

class MidtransProvider implements PaymentProvider {
  readonly code = "midtrans";
  async initiate(...) { /* call Midtrans Snap; return { status: "redirect", redirectUrl, providerRef } */ }
  async capture(...) { /* Midtrans captures on charge; return { status: "captured" } */ }
  async refund(...) { /* call Midtrans refund API */ }
  verifyWebhookSignature({ rawBody, headers }) {
    // SHA512 of (orderId + statusCode + grossAmount + serverKey)
    // Compare to headers["x-signature"]; throw on mismatch.
    // Return { event, providerRef, status, rawPayload }.
  }
}
```

The plugin loader's startup hook calls
`paymentProviderRegistry.register(new MidtransProvider({ apiKey }))`.

## Follow-ups (out of scope this round)

- **Partial refund modeling.** v0.1 records partial-refund amounts on
  the attempt's `requestPayload`. A future iteration adds a `refunded_amount`
  column on the parent row + child rows for each partial refund.
- **Authorize-then-capture state.** The `authorized` status is in the
  state machine and accepted by capture, but no v0.1 provider returns
  `authorized` from `initiate`. Add when the first such provider lands.
- **TTL / abandoned-payment cleanup.** A pending payment for a stale
  checkout has no garbage collector today. A future job sweeps
  pending rows older than N days.
- **Webhook retry.** `handleWebhook` is idempotent; a future
  enhancement persists the inbound webhook in BullMQ for at-least-once
  redelivery if the signature passed but the downstream transition
  failed.
- **Multi-payment per order.** v0.1 enforces one payment per order via
  the storefront flow. Split payments / installments would relax this
  to many-to-one.
