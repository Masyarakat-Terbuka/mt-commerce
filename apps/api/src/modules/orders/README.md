# Orders module

Owns the canonical financial order record. Materialises an `order_intent`
written by the checkout module into `orders` + `order_items` rows, walks
the order through its lifecycle states, and emits typed events so other
modules (notifications, payments, fulfillment) can react.

Per ADR-0005 no other module reads or writes order tables directly —
cross-module callers go through `orderService`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table                  | Purpose                                                  | ID prefix |
| ---------------------- | -------------------------------------------------------- | --------- |
| `orders`               | Canonical order record (one per checkout completion)     | `ord_`    |
| `order_items`          | Line-item snapshots (price, sku, title translations)     | `oi_`     |
| `order_status_history` | Append-only audit log of state transitions               | `osh_`    |

`orders.order_number` is allocated from the Postgres sequence
`order_number_seq` (start 100000) and formatted at the application
boundary as `ORD-YYYY-NNNNNN`. The sequence is the database-side
guarantee against collisions; the format is the customer-facing handle.

`order_items.title_translations` captures the per-locale title at order
time. The merge favours the variant title when present and falls back
to the product title (per ADR-0010 — snapshots are translation-aware).
The mapper resolves the requested locale at read time.

`order_status_history.actor_kind` separates `system | staff | customer`
so the audit trail makes "who did what" explicit. Staff transitions
carry `actor_id = auth_user.id` from the session.

## State machine

```
   ┌──────────────────┐
   │ pending_payment  │
   └─────┬──────┬─────┘
         │      └──► cancelled (terminal)
         │ paid
         ▼
   ┌─────────┐
   │  paid   │ ─────► cancelled (terminal)
   └────┬────┘
        ├──► refunded (terminal)
        │ fulfilled
        ▼
   ┌────────────┐
   │ fulfilled  │ ─────► refunded (terminal)
   └────────────┘
```

Allowed transitions (also pinned in `state.ts` and exhaustively tested):

- `pending_payment → paid`            (payment captured)
- `pending_payment → cancelled`       (e.g. unpaid expiration)
- `paid → fulfilled`                  (handed off to shipping)
- `paid → cancelled`                  (rare; refund track follows)
- `paid → refunded`                   (direct refund)
- `fulfilled → refunded`              (post-shipment refund)

Terminal states: `cancelled`, `refunded`. Refunds cannot be undone via
the state machine — operators issue a new order if the buyer reorders.

## Service interface

```ts
import { orderService, type OrderService } from "./modules/orders";
```

```ts
interface OrderService {
  createFromIntent(orderIntentId, opts?): Promise<Order>;
  getOrderById(id, opts?): Promise<Order | null>;
  getOrderByNumber(orderNumber, opts?): Promise<Order | null>;
  listOrders(query, opts?): Promise<Paginated<Order>>;
  listCustomerOrders(customerId, query, opts?): Promise<Paginated<Order>>;
  transitionStatus(id, toStatus, { actorKind, actorId, details? }): Promise<Order>;
  cancelOrder(id, { reason, actorKind, actorId }): Promise<Order>;
  listStatusHistory(orderId): Promise<OrderStatusEvent[]>;
}
```

`createFromIntent` runs in a single transaction:

1. Read the `order_intent` row.
2. Refuse with `ConflictError {code:"intent_already_consumed"}` if an
   order already exists for this intent.
3. Allocate the next `order_number` from the sequence.
4. Capture each variant's `(product, variant)` translations into the
   line-item `title_translations` snapshot.
5. Insert the `orders`, `order_items`, and initial
   `order_status_history` rows.
6. Emit `order.placed` and `order.status_changed` on the bus.

Emitted events:

| Event                  | Payload                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `order.placed`         | `{ orderId, orderNumber, customerId, email, totalAmount, currency }`         |
| `order.paid`           | `{ orderId, orderNumber, actorKind }`                                        |
| `order.fulfilled`      | `{ orderId, orderNumber, actorKind }`                                        |
| `order.cancelled`      | `{ orderId, orderNumber, reason, actorKind }`                                |
| `order.refunded`       | `{ orderId, orderNumber, actorKind }`                                        |
| `order.status_changed` | `{ orderId, orderNumber, fromStatus, toStatus, actorKind }` (every change)   |

## Routes

### Admin (`/admin/v1`) — `requireRole("owner", "admin", "staff")`

| Method | Path                              | Purpose                                            |
| ------ | --------------------------------- | -------------------------------------------------- |
| GET    | `/orders`                         | List + filter (status, customer, email, date)      |
| GET    | `/orders/:id`                     | Detail with full status history                    |
| GET    | `/orders/:id/events`              | Audit-trail events                                 |
| POST   | `/orders/:id/transition`          | `{ toStatus, details? }` — staff actor captured    |
| POST   | `/orders/:id/cancel`              | `{ reason }` — convenience wrapper for cancelled   |

### Storefront (`/storefront/v1`)

Customer auth integration is still landing. Until then, the storefront
identifies the caller via the `x-customer-id` header. A 401 is returned
when the header is missing — never a 200 with someone else's orders.

| Method | Path                                  | Purpose                              |
| ------ | ------------------------------------- | ------------------------------------ |
| GET    | `/customer/me/orders`                 | Paginated list of caller's orders    |
| GET    | `/customer/me/orders/:orderNumber`    | Detail by `order_number`             |

## Checkout integration

`checkoutService.complete(...)` writes an `order_intent`, then calls
`orderService.createFromIntent(intent.id, { actorKind: "customer" })` in
a follow-on transaction so a failure to create the order does NOT roll
back the checkout completion. If the order creation fails, the call
logs and queues the intent for retry — the response still carries the
order_intent so existing storefront callers stay backward-compatible,
and (when the order succeeded) it carries the `order` alongside.

## Locale handling

Every read accepts `?locale=` (or `Accept-Language`). Title translations
are resolved at read time via the catalog module's
`resolveTranslations` helper, applying the documented fallback chain:
requested locale → default locale (`id`) → first locale present →
empty string.

## Money on the wire

Every `Money` value renders as `{ "amount": "<decimal-string>",
"currency": "IDR" }` per ADR-0007. The order's `currency` is captured
once at the parent row and every monetary column on the row uses it.
The line-item `unit_price_currency` is denormalised onto each item for
defense-in-depth — any divergence from the order's currency would be a
programming error caught in tests.

## Follow-ups (out of scope this round)

- **Real payment integration.** `transitionStatus(... 'paid')` is a
  manual move today. The Midtrans plugin work will gate the transition
  behind a captured payment, with the provider tx id flowing through
  `details.providerReference`.
- **Real fulfillment flow.** `paid → fulfilled` is also manual; the
  shipping module (Biteship plugin) will create the fulfillment, attach
  tracking, and call `transitionStatus(..., 'fulfilled', { details: {
  trackingCode } })`.
- **Refunds.** The state machine permits `paid → refunded` and
  `fulfilled → refunded`, but refund processing itself (provider
  callout, partial refunds) is the payment module's territory.
- **Tax rate snapshot.** The `tax_rate_code` and `tax_rate_basis_points`
  columns are nullable today because `order_intent.totalsSnapshot`
  carries only money values. The tax module's next round will snapshot
  the rate row too; the orders service will backfill these columns at
  that point.
- **Customer auth integration.** Storefront routes use the
  `x-customer-id` header stand-in. The auth module's next round
  replaces the header read with a session lookup; route shapes do not
  change.
- **Event-bus persistence.** The bus is in-process; a crash between
  commit and emit drops the in-memory event. Persistent BullMQ-backed
  emission lands when the notification module needs it.
