# Shipping module

Stores shipping methods and resolves quotes through pluggable providers.
v0.1 ships with the **manual** provider — operator-defined flat rates
configured per method. Future plugin providers (Biteship, JNE direct)
will register against the same `ShippingProvider` interface and resolve
rates dynamically.

## Storage

`shipping_methods`:

- `code` (UNIQUE) — operator-facing identifier, e.g. `MANUAL_FLAT`,
  `JNE_REG`.
- `provider_kind` (text) — `'manual' | 'plugin'`. Plain text so a future
  plugin can extend the set without a schema migration.
- `flat_rate_amount`, `flat_rate_currency` — populated only for manual
  methods. A DB CHECK enforces the cross-column rule:
  `manual ⇒ both NOT NULL, amount >= 0; plugin ⇒ both NULL`.
- `is_active`, `deleted_at` — soft-retire (sets `deleted_at` and
  `is_active = false`).

`fulfillments`:

- `order_id` (FK, cascade) — pointer to the canonical order. Cascades
  on hard delete (defense-in-depth; orders are not hard-deleted in
  v0.1). The previous `order_intent_id` placeholder was swapped in
  migration `0014_fulfillments_order_id`.
- `shipping_method_id` (FK, restrict) — soft-retire methods rather than
  hard-delete to keep the audit trail intact.
- `status` (text) — `pending | shipped | delivered | cancelled` v0.1
  lifecycle. Plain text so future states (`returned`, ...) do not require
  a schema migration.
- `tracking_code` — free-text courier reference, populated by the
  operator (manual) or the plugin (future).
- `tracked_at` / `delivered_at` — denormalised lifecycle timestamps so
  admin filters ("orders shipped this week") do not need to scan the
  audit log.

## Service surface

`ShippingService`:

| method | purpose |
| --- | --- |
| `listMethods({ activeOnly })` | listing for admin and storefront |
| `getById(id)` | admin detail |
| `getByCode(code)` | lookups by stable code (used by checkout) |
| `quote({ methodCode, currency })` | dispatches to the provider for the method's `providerKind` and asserts currency parity |
| `createMethod(input)` | admin create (validates manual ↔ flatRate cross-field rule) |
| `updateMethod(id, patch)` | admin update |
| `deleteMethod(id)` | admin soft-delete |
| `createFulfillmentForOrder(orderId, { methodCode }, repo?)` | create `pending` fulfillment for an order; called by the orders service inside the `→ paid` transition (passing its tx-scoped repo) |
| `getFulfillmentById(id)` / `listFulfillmentsByOrderId(orderId)` / `listFulfillmentsForOrders(orderIds)` | reads; the orders module batches across a list response |
| `setTracking(id, { actor, trackingCode })` | set/clear the tracking code without a status change |
| `markShipped(id, { actor, trackingCode? })` | `pending → shipped`; stamps `tracked_at`, optionally captures tracking in the same op |
| `markDelivered(id, { actor })` | `shipped → delivered`; stamps `delivered_at`. The route layer best-effort transitions the parent order `paid → fulfilled` |
| `cancel(id, { actor, reason? })` | `pending|shipped → cancelled`; does NOT cancel the parent order |

## Providers

`ShippingProvider` is intentionally narrow at v0.1 — a single `quote(method, { currency })` method. Keeping the surface narrow means the cart/checkout integration does not need to change when plugin providers land.

`ManualShippingProvider` returns the configured flat rate. The currency
parity check lives at the service boundary; a manual method whose
`flat_rate_currency` does not match the requested currency surfaces as
`ValidationError {code:"currency_mismatch"}`.

## Routes

Shipping methods:

- `GET /admin/v1/shipping/methods?activeOnly=`
- `POST /admin/v1/shipping/methods`
- `GET /admin/v1/shipping/methods/:id`
- `PATCH /admin/v1/shipping/methods/:id`
- `DELETE /admin/v1/shipping/methods/:id` — soft-delete
- `GET /storefront/v1/shipping/methods?currency=IDR` — public, active only
- `POST /storefront/v1/shipping/quote` — body `{ methodCode, currency }`,
  returns `{ amount: Money }`

Fulfillments (admin):

- `GET /admin/v1/fulfillments?orderId=`
- `GET /admin/v1/fulfillments/:id`
- `PATCH /admin/v1/fulfillments/:id/tracking` — body `{ trackingCode }`
  (pass `null` to clear)
- `POST /admin/v1/fulfillments/:id/mark-shipped` — body `{ trackingCode? }`
- `POST /admin/v1/fulfillments/:id/mark-delivered` — also nudges the
  parent order `paid → fulfilled` best-effort
- `POST /admin/v1/fulfillments/:id/cancel` — body `{ reason? }`

Each mutation writes an audit row (`entityKind: "fulfillment"`).

Admin routes are gated by `requireAuth` + `requireRole("owner",
"admin", "staff")`.

## Order ↔ fulfillment lifecycle

```
order.pending_payment ──► order.paid ──► (fulfillment.created, status=pending)
                                          │
                                          ▼
                                      fulfillment.shipped (operator)
                                          │
                                          ▼
                                      fulfillment.delivered (operator)
                                          │
                                          ▼
                            order.fulfilled (best-effort, route-layer composition)
```

The orders service injects a `ShippingService` and the orders repository
exposes a tx-scoped shipping repo so the create-on-paid insert lands in
the same transaction as the order update — partial failure cannot leave
a `paid` order without a fulfillment row. The `delivered → order.fulfilled`
edge happens at the routes layer (rather than from inside the shipping
service) so each module's service stays focused on its own bounded
context per ADR-0005; the route swallows a `ConflictError` on the
order-side transition so a "mark delivered" never fails because the
order was already in a terminal state.

## Checkout integration

The checkout's `setShipping` no longer accepts a client-supplied amount.
It validates the `shippingMethodCode` against
`shippingService.getByCode(...)` and resolves the price via
`shippingService.quote(...)`. The captured shipping currency is
asserted against the cart's currency at the boundary; a mismatch raises
`ValidationError {code:"currency_mismatch"}`.

## Why a separate provider abstraction at v0.1

The `ShippingProvider` interface looks like over-engineering for a
single manual implementation. It is not — registering plugin providers
through the same map as the manual one is the entire point of ADR-0008
(plugins as npm packages). Building the seam now means the Biteship
plugin's milestone is "implement `ShippingProvider`, register the
instance" rather than "rewrite the shipping service to support plugins".
