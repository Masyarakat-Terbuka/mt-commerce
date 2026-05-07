# Checkout module

Owns the state machine that takes an active `Cart` and walks it through
address collection, shipping selection, and payment to produce an
`order_intent` record. Per ADR-0005 no other module reads or writes
checkout tables directly — cross-module callers go through
`checkoutService`.

## State machine

```
   ┌───────────┐
   │  pending  │
   └─────┬─────┘
         │ setAddresses
         ▼
 ┌──────────────────┐  setAddresses (revise)
 │ awaiting_        │ ◄────────────────┐
 │   shipping       │                  │
 └─────────┬────────┘                  │
           │ setShipping               │
           ▼                           │
 ┌──────────────────┐ setAddresses (revise) │
 │ awaiting_        │ ──────────────────────┘
 │   payment        │
 │                  │ setShipping (revise)  ──┐
 └─────────┬────────┘ ◄───────────────────────┘
           │
           │ complete
           ▼
   ┌─────────────┐
   │  completed  │  (terminal — produces order_intent;
   └─────────────┘   marks cart status='converted')

  cancel(reason) — any non-terminal state ─►  ┌──────────┐
                                              │  failed  │  (terminal)
                                              └──────────┘
```

Forward-only with two relaxations:

- From `awaiting_shipping` and `awaiting_payment`, the customer can
  **revise** addresses or shipping selection. The state machine treats
  this as either a self-loop (re-setting the same data class) or a
  backward step (`awaiting_payment → awaiting_shipping` when revising
  addresses).
- `cancel` moves any non-terminal state to `failed` with an optional
  reason.

Terminal states are frozen forever: a customer who needs to retry after
a failure starts a new checkout from the same cart.

## Schemas

All under `apps/api/src/db/schema/`:

| Table              | Purpose                                                           | ID prefix |
| ------------------ | ----------------------------------------------------------------- | --------- |
| `checkouts`        | State machine row + selections (shipping/billing/payment)         | `chk_`    |
| `checkout_events`  | Append-only audit log of state transitions                        | `cke_`    |
| `order_intents`    | Placeholder consumed by the future Order module (one per checkout)| `oint_`   |
| `idempotency_keys` | Backs the `Idempotency-Key` middleware                            | n/a       |

### `order_intents` — placeholder contract

The Order module does **not** exist yet. When the `complete` transition
fires, the checkout writes a placeholder `order_intent` row carrying full
snapshots of the cart, the totals, the shipping address, and (optionally)
the billing address. The Order module's first ticket will:

1. Read pending `order_intents` (or react to `checkout.completed`),
2. Materialize canonical `orders` + `order_items` rows from the
   snapshots,
3. Mark or delete the consumed `order_intent` (the exact handover is
   the Order module's call).

Storing a full snapshot rather than just the FKs is intentional: it
prevents a customer mid-checkout address edit from retroactively
rewriting the order, and it lets the Order module land later without
needing to re-resolve cross-module state.

### Idempotency

The completing transition is the canonical idempotent endpoint per
ARCHITECTURE.md and SECURITY.md. The
`apps/api/src/middleware/idempotency.ts` middleware:

1. Requires `Idempotency-Key` on opt-in routes (missing → 400
   `idempotency_key_required`).
2. On first call: runs the handler, stores
   `(scoped_key, request_hash, status, response_body)` in
   `idempotency_keys`.
3. On replay with the same scoped key:
   - same `request_hash` → returns the stored response unchanged,
   - different `request_hash` → 409 `idempotency_key_reuse`.
4. Scopes via `sha256(scope || ":" || raw_key)` so the same client-side
   string for `checkout.complete` and `payment.refund` cannot collide.

The `idempotency_keys` table carries `created_at` so a future cleanup
job can drop rows older than 24 hours. The cleanup itself is a follow-up.

## Service interface

```ts
import { checkoutService, type CheckoutService } from "./modules/checkout";
```

```ts
interface CheckoutService {
  // Lifecycle
  startCheckout({ cartId, email? }): Promise<Checkout>;
  getCheckout(id): Promise<Checkout | null>;
  setAddresses(checkoutId, { shippingAddressId, billingAddressId? }): Promise<Checkout>;
  setShipping(checkoutId, { shippingMethodCode, shippingAmount }): Promise<Checkout>;
  complete(checkoutId, { paymentMethod, idempotencyKey }):
    Promise<{ checkout: Checkout, orderIntent: OrderIntent }>;
  cancel(checkoutId, { reason? }): Promise<Checkout>;

  // Reads
  listCheckouts(query): Promise<Paginated<Checkout>>;
  listEvents(checkoutId): Promise<CheckoutEvent[]>;
}
```

The `complete` flow runs in a single transaction:

1. Re-read the checkout (defense against a racer).
2. Snapshot the cart + items + totals + addresses.
3. Insert `order_intents`.
4. Mark the cart `status='converted'` (cross-module write — see
   `repository.ts` header for the rationale).
5. Update the checkout to `state='completed'` and capture the
   idempotency key.
6. Append the audit-log row.
7. Emit `checkout.payment_initiated` and `checkout.completed` on the bus.

## Routes

### Storefront (`/storefront/v1`)

| Method | Path                                  | Notes                            |
| ------ | ------------------------------------- | -------------------------------- |
| POST   | `/checkouts`                          | start; `email` required for guest|
| GET    | `/checkouts/:id`                      | bearer = the checkout id         |
| PUT    | `/checkouts/:id/addresses`            | re-runnable; revisions allowed   |
| PUT    | `/checkouts/:id/shipping`             | re-runnable; revisions allowed   |
| POST   | `/checkouts/:id/complete`             | **requires `Idempotency-Key`**   |
| POST   | `/checkouts/:id/cancel`               | non-terminal → failed            |

### Admin (`/admin/v1`) — `requireRole("owner", "admin", "staff")`

| Method | Path                          | Purpose                  |
| ------ | ----------------------------- | ------------------------ |
| GET    | `/checkouts`                  | list + filter + paginate |
| GET    | `/checkouts/:id`              | detail                   |
| GET    | `/checkouts/:id/events`       | audit trail              |

## Event bus

`apps/api/src/modules/checkout/events.ts` ships a tiny in-process typed
event bus. ARCHITECTURE.md describes the long-term split: lightweight
cross-module reactions go through this bus; critical workflows that
must not be lost (e.g. fulfillment kicked off by `checkout.completed`)
also enqueue a BullMQ job.

Events fired by this module:

| Event                         | Payload                                         |
| ----------------------------- | ----------------------------------------------- |
| `checkout.started`            | `{ checkoutId, cartId }`                        |
| `checkout.shipping_set`       | `{ checkoutId, shippingMethodCode }`            |
| `checkout.payment_initiated`  | `{ checkoutId, paymentMethod }`                 |
| `checkout.completed`          | `{ checkoutId, orderIntentId, cartId }`         |
| `checkout.failed`             | `{ checkoutId, reason }`                        |

## Money on the wire

Every `Money` value renders as `{ "amount": "<decimal-string>", "currency": "IDR" }`
per ADR-0007. Currency parity is enforced at the cart-locking step; the
checkout refuses a `setShipping` that uses a different currency than
the underlying cart (`ValidationError {code:"currency_mismatch"}`).

## Follow-ups (out of scope this round)

- **Order module consumes `order_intents`.** Replace the placeholder
  table with canonical `orders` + `order_items` (still readable from
  the snapshots). Drop `order_intents` rows after consumption (or keep
  them for rebuild auditing — to be decided in the Order module ticket).
- **Real shipping module.** The current `setShipping` accepts any
  string code + a caller-supplied amount; the future shipping module
  computes the rate from a provider, enforces a code set, and replaces
  the request body shape. The route URL stays.
- **Real payment module.** The current `complete` accepts any
  `paymentMethod` string and treats the call as authoritative
  ("payment captured by some out-of-band step"). The Midtrans / payment
  plugin work will gate `complete` behind a real payment intent and
  branch to `failed` on declined cards.
- **Guest address creation.** `setAddresses` currently rejects guest
  checkouts with `code: "guest_address_unsupported"`. A guest-address
  creation flow lands with the storefront's checkout UX.
- **Auth-derived checkout ownership.** Storefront routes treat the
  checkout id as the bearer (parity with cart). When customer-auth
  integration matures, add `/customer/me/checkouts` family + tighter
  guards.
- **Checkout sweep job.** `expires_at` defaults to `now() +
  interval '1 hour'`. A BullMQ job will mark expired non-terminal
  checkouts as `failed` and free their carts.
- **Idempotency-key TTL job.** `idempotency_keys.created_at` carries an
  index for the future scan.
- **Persistent event bus.** The current bus is in-process, fire-and-wait
  with per-listener catch+log. Critical events (e.g. fulfillment) should
  also go through BullMQ once those modules exist.
- **`checkout.completed` after-commit emission.** v0.1 emits inside the
  same transaction as the writes; a crash between commit and emit would
  drop the in-memory event. Acceptable for v0.1 because every listener
  today is best-effort; the persistent path closes the gap when it lands.
