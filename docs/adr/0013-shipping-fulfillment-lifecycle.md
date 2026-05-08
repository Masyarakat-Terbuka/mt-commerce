# ADR-0013: Shipping fulfillment lifecycle and plugin context

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

Shipping in mt-commerce splits into two related-but-distinct concerns:

1. **Quoting** — given a method and a buyer destination, what does shipping cost? Manual methods return a flat rate; plugin methods (Biteship, JNE direct, etc.) compute live rates from the destination and the cart.
2. **Fulfillment** — given an order that has been paid for, has the operator handed it to the courier? When did it ship? When was it delivered? Was it cancelled?

The first concern is read-only and stateless. The second is a small state machine attached to the order that operators move through manually (or, in a future plugin world, in response to courier webhooks).

Several modelling decisions follow:

- Where does the fulfillment record live — on the order row, in a sibling table, or split across multiple rows?
- What states does it move through, and what enforces the transitions?
- When a fulfillment is delivered, who decides the parent order is "fulfilled" — the shipping service, the orders service, or somewhere else?
- How do plugin shipping providers receive the buyer's destination and cart contents without reaching back into the platform's database?

Indonesian commerce makes the destination shape concrete: buyers select a four-level region tree (provinsi / kota-kabupaten / kecamatan / kelurahan) plus a postal code. Couriers receive these in different forms — Biteship has its own area ids, JNE has destination tariff codes — and the translation is the courier's concern, not the platform's.

---

## Decision

Fulfillments are a **separate row**, keyed on `order_id`. The schema is at `apps/api/src/db/schema/fulfillments.ts`; the service is at `apps/api/src/modules/shipping/service.ts`. The state machine is:

```
pending ──► shipped ──► delivered
        ↘            ↘
          cancelled    cancelled
```

The transition from a delivered fulfillment to a fulfilled order — `markDelivered` → `order.fulfilled` — is performed by the **route layer**, not the shipping service. An invalid order transition (already fulfilled, cancelled, or refunded) is logged and ignored; the fulfillment-side write is authoritative.

`ShippingProvider.quote` (in `@mt-commerce/core/plugin`) accepts a context object with optional `destination` and `items`. The destination uses BPS region ids — the same shape stored on `customer_addresses` and `orders.shipping_address_snapshot`. The manual provider ignores both fields; plugin providers consume them and throw a clear domain error when a required field is missing.

---

## Consequences

### Positive

A separate fulfillment row matches how the data is actually used. The orders module owns the financial record (status, totals, items, snapshots); the shipping module owns the operational record (status, tracking code, shipped/delivered timestamps). Splitting them lets each evolve independently — adding a `returned` state to fulfillment does not touch the orders schema; adding a `partially_refunded` state to orders does not touch the shipping schema.

The state machine is small and enforced in the application layer. The `status` column is plain `text` (not a `pgEnum`), so adding a state in a future iteration is a code change, not a migration. Per-state denormalisations live on the row (`tracked_at`, `delivered_at`) so admin filters like "orders shipped this week" run as an indexed query without scanning the audit trail.

The route-layer `delivered → fulfilled` composition keeps each service inside its own bounded context (per [ADR-0005](./0005-modular-monolith.md)). The shipping service does not import the orders service to drive a parent transition; the orders service does not subscribe to fulfillment events to react to them. Both surfaces remain testable in isolation. The route handler reads as a literal sentence — "mark this fulfillment delivered, then if the order can become fulfilled, do that" — which is the right grain for a cross-module coordination.

The optional `destination` and `items` on `ShippingProvider.quote` is the additive evolution of a contract that initially carried only `currency`. Manual flat-rate providers ignore the new fields and the call shape is unchanged. Plugin providers that need them consume them; providers that need fields not in the context (lat/lon, declared customs value) validate eagerly and throw a domain error. The contract grows by addition, not by per-provider flags.

BPS region ids on `ShippingQuoteDestination` are the right cross-plugin shape because every Indonesian courier already maps to or from them — they are the government-issued canonical identifiers for administrative regions. A plugin author shipping a Biteship integration translates `kotaKabupatenId: "3273"` to Biteship's internal area id once, in the plugin. Couriers that don't operate in Indonesia would extend the contract; v0.1 has no such case.

### Negative

A delivered fulfillment whose `markDelivered` call succeeded but whose order transition silently failed (because the order was already `cancelled`, say) leaves the two sides describing different things. We treat the fulfillment side as authoritative and accept the gap; an admin view shows both records, and an operator can reason about it. The alternative — refusing to mark delivered until the order's state allows — would punish operators for timing they can't control.

Plugin providers that need a richer destination than BPS ids can describe (provider-specific area codes, geo-coordinates) carry that translation themselves. The platform does not bundle a region-code translation table for any specific courier. This is the right boundary, but it does mean a Biteship plugin and a JNE plugin each write their own mapping — there is no shared library for it.

The fulfillment row is created lazily, on the order's `paid` transition. A buyer who pays and never has a fulfillment created (because the operator deleted the order, say, or the orders service crashed mid-transition) has no shipping-side record. v0.1 accepts this; the orders service's `paid` transition writes the fulfillment in the same transaction, so the only path to inconsistency is hard-deleting an order, which v0.1 does not do.

---

## What this module does NOT do

- **Courier webhooks.** The shipping service has no webhook entry point. A plugin that wants to react to courier delivery events writes its own route handler and calls `shippingService.markDelivered(...)` from there.
- **Multi-package fulfillment.** One order, one fulfillment in v0.1. Splitting an order across two parcels needs schema changes that we have not made.
- **Returns or RMAs.** Cancellation is the only "going backwards" state. A returned package is an audit-and-refund concern handled through the orders/payments side.
- **Live label printing or manifest generation.** A plugin can do this on the `fulfillment.shipped` event; the platform does not.

---

## Alternatives considered

### Fulfillment fields on the order row

Storing `tracking_code`, `shipped_at`, and `delivered_at` directly on `orders` was considered. It works for the simple case but breaks the moment a single order ships in two parcels (which mt-commerce does not support today, but the schema should not preclude). It also conflates two state machines onto one row — the order's financial status (`pending_payment`, `paid`, `cancelled`, `refunded`) and the fulfillment's operational status (`pending`, `shipped`, `delivered`) — which makes the orders module's transition table grow combinatorially. Rejected.

### Have the shipping service drive `order.fulfilled` directly

The shipping service could call `orderService.transitionStatus(orderId, "fulfilled", ...)` from inside `markDelivered`. It is straightforward and concentrates the logic. It was rejected because it pulls a hard dependency from shipping to orders; both modules then have to mock the other for tests, and the bounded-context rule from [ADR-0005](./0005-modular-monolith.md) erodes. The route-layer composition keeps the dependency in the HTTP boundary, which is where cross-module coordination naturally lives.

### Event-driven `delivered → fulfilled` instead of route-layer call

The shipping service emits `fulfillment.delivered` already; the orders module could subscribe and transition on its own. This is closer to a "good distributed-systems shape" but adds more moving parts than the situation calls for: the in-process event bus is fire-and-forget, so a listener failure is silent unless an operator notices the order stayed in `paid`. The synchronous route-layer call surfaces failures (logged at warn) at the request that triggered them, which is what an operator wants while clicking "mark delivered." We may revisit this once a worker process makes async-fanout reactions first-class. Rejected for v0.1.

### A single `provider_kind` map with one provider per kind

The shipping service initially had a `Map<ShippingProviderKind, ShippingProvider>` keyed by `manual | plugin`. A single map cannot hold multiple plugin providers (a Biteship plugin and a JNE plugin both want the `plugin` kind), so the service now has a second `Map<code, PluginShippingProvider>` for plugin-supplied providers. Each method row carries the `code` it routes to. This is the same shape used by the payments module's registry. Rejected the single-map approach in favour of two-map dispatch.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module ownership and the rationale for route-layer composition.
- [ADR-0008](./0008-plugins-as-npm-packages.md) — plugins as npm packages.
- [ADR-0010](./0010-product-content-translations.md) — the broader pattern of capturing snapshot data at order time.
- `apps/api/src/db/schema/fulfillments.ts` — the table.
- `apps/api/src/modules/shipping/` — the service.
- `packages/core/src/plugin.ts` — `ShippingProvider`, `ShippingQuoteDestination`, `ShippingQuoteItem`.
