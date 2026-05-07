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

`fulfillments` (placeholder per the v0.1 checklist):

- `order_intent_id` (FK, cascade) — pointer to the placeholder consumed
  by the future Order module. Will swap to `order_id` once orders land.
- `shipping_method_id` (FK, restrict) — soft-retire methods rather than
  hard-delete to keep the audit trail intact.
- `status` (text) — `pending | fulfilled | cancelled` v0.1 lifecycle.
- `tracking_code` — free-text courier reference, populated by the
  operator (manual) or the plugin (future).

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
| `createFulfillment(orderIntentId, methodCode)` | minimal placeholder until the Order module materializes orders |

## Providers

`ShippingProvider` is intentionally narrow at v0.1 — a single `quote(method, { currency })` method. Keeping the surface narrow means the cart/checkout integration does not need to change when plugin providers land.

`ManualShippingProvider` returns the configured flat rate. The currency
parity check lives at the service boundary; a manual method whose
`flat_rate_currency` does not match the requested currency surfaces as
`ValidationError {code:"currency_mismatch"}`.

## Routes

- `GET /admin/v1/shipping/methods?activeOnly=`
- `POST /admin/v1/shipping/methods`
- `GET /admin/v1/shipping/methods/:id`
- `PATCH /admin/v1/shipping/methods/:id`
- `DELETE /admin/v1/shipping/methods/:id` — soft-delete
- `GET /storefront/v1/shipping/methods?currency=IDR` — public, active only
- `POST /storefront/v1/shipping/quote` — body `{ methodCode, currency }`,
  returns `{ amount: Money }`

Admin routes are gated by `requireAuth` + `requireRole("owner",
"admin", "staff")`.

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
