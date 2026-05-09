# Cart module

Owns shopping carts and cart line items, plus pure totals computation.
Per ADR-0005 no other module reads or writes cart tables directly —
cross-module callers go through `cartService`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table        | Purpose                                         | ID prefix |
| ------------ | ----------------------------------------------- | --------- |
| `carts`      | Cart header (currency lock, status, expiry)     | `cart_`   |
| `cart_items` | Line items: `(cart, variant) → quantity, price` | `ci_`     |

### Currency lock

A cart is single-currency. The `currency` column on `carts` is set when the
cart is created and is never relaxed. The service refuses any `addItem`
whose variant currency does not equal the cart's currency
(`ValidationError {code:"currency_mismatch"}`). This is a hard rule because
otherwise the cart's total — and the order derived from it — could not be a
single `Money` value.

### Variant FK semantics

`cart_items.variant_id` references `product_variants.id` with **no `ON
DELETE`** clause. Deleting a variant must NOT silently mutate a cart
already holding it. The default `RESTRICT` surfaces the conflict so an
operator decides what to do (refund, contact the customer, archive the
cart). The catalog module's variant soft-delete sets `deleted_at` rather
than removing the row, so this in practice only bites a hard delete.

### Captured price

Every line stores `unit_price_amount` and `unit_price_currency` at add-time.
Catalog price changes do NOT silently re-price the cart. The shopper sees
the price they added at; a re-add of the same variant updates the captured
price (the most recent shopper intent wins — see "Merge semantics" below).
The order copies these captured amounts so the audit trail survives
catalog → cart → order.

### Merge semantics

`(cart_id, variant_id)` is UNIQUE. Adding the same variant twice merges
into a single line with summed quantity. The merged line's `unit_price`
takes the latest add's price — matching the storefront mental model of
"I added it again, that's the price now."

`mergeGuestIntoCustomer` keeps the customer cart's `unit_price` unchanged
when an incoming guest line shares a variant. We assume the customer's
existing line was a more deliberate decision than the guest's and a fresh
sign-in should not silently re-price it.

### Status lifecycle

```
active ──► abandoned          (sweep job or admin override)
   │
   └────► converted            (an order was created from this cart)
```

`converted` is terminal — `markAbandoned` and `clear` refuse a converted
cart, and a guest cart marked converted by `mergeGuestIntoCustomer` cannot
be merged again.

## Service interface

```ts
import { cartService, type CartService } from "./modules/cart";
```

```ts
interface CartService {
  // Lifecycle
  createGuestCart(currency): Promise<Cart>;
  createCustomerCart(customerId, currency): Promise<Cart>;

  // Reads
  getCartById(id): Promise<Cart | null>;
  getActiveCartForCustomer(customerId): Promise<Cart | null>;
  listCarts(query): Promise<Paginated<Cart>>;

  // Items
  addItem(cartId, { variantId, quantity }): Promise<Cart>;
  updateItemQuantity(cartId, itemId, quantity): Promise<Cart>; // 0 ⇒ remove
  removeItem(cartId, itemId): Promise<Cart>;
  clear(cartId): Promise<Cart>;

  // Cross-cart
  mergeGuestIntoCustomer(guestCartId, customerId): Promise<Cart>;

  // Status
  markAbandoned(cartId): Promise<Cart>;

  // Pure compute
  getTotals(cart): CartTotals;
}
```

## Routes

### Admin (`/admin/v1`) — `requireRole("owner", "admin", "staff")`

| Method | Path                 | Purpose                   |
| ------ | -------------------- | ------------------------- |
| GET    | `/carts`             | List + filter + paginate  |
| GET    | `/carts/:id`         | Detail (with totals)      |
| POST   | `/carts/:id/abandon` | Mark abandoned (override) |

### Storefront (`/storefront/v1`)

| Method | Path                       | Auth        |
| ------ | -------------------------- | ----------- |
| POST   | `/carts`                   | public      |
| GET    | `/carts/:id`               | public      |
| POST   | `/carts/:id/items`         | public      |
| PATCH  | `/carts/:id/items/:itemId` | public      |
| DELETE | `/carts/:id/items/:itemId` | public      |
| POST   | `/carts/:id/clear`         | public      |
| GET    | `/customer/me/cart`        | requireAuth |
| POST   | `/customer/me/cart`        | requireAuth |

#### Auth gating

The `/customer/me/cart` endpoints are gated by `requireAuth()`. The
domain customer is resolved from the session cookie's auth_user via
`customerService.getCustomerByAuthUserId(authUser.id)`. A signed-in
auth_user without a customer profile gets a 404 with `details.code =
"customer_not_provisioned"`. The public cart routes treat the cart's
ULID as the bearer — anyone with the id can act on the cart, which
mirrors the typical guest-cart flow shoppers expect.

## Totals semantics

`getTotals(cart, opts?)` is pure (no DB I/O). It computes:

| Field    | Computation                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| subtotal | Σ (`unit_price * quantity`) across line items                                                                                      |
| tax      | `subtotal * (basisPoints / 10000)` (halfEven) when `opts.taxRate` provided; otherwise `subtotal * TAX_PPN_RATE` (env-var fallback) |
| shipping | `opts.shipping` when provided (currency-checked); otherwise `zero(currency)`                                                       |
| total    | `subtotal + tax + shipping`                                                                                                        |
| taxRate  | `{ code, basisPoints }` echo of the applied rate, or null on the env-var fallback path                                             |

The cart module no longer reaches for the tax or shipping modules
directly. Callers fetch the rate (`taxService.getDefaultRate(cart.currency)`)
and the shipping amount (`shippingService.quote(...)`) outside the cart
and pass them in via `opts`. Per ADR-0005 this keeps the cart module
free of cross-module imports.

`TAX_PPN_RATE` (env var) is retained as a fallback for tests and
unseeded dev DBs. Production deployments seed a `tax_rates` row (see
the tax module README) so the env-var fallback never fires in practice.

`getTotals` is called from cart reads (admin and storefront) and embedded
in the response so clients see the breakdown immediately. Future order
creation will call it on the same `Cart` to compute the order header.

### Money on the wire

Every `Money` value renders as `{ "amount": "<decimal-string>", "currency": "IDR" }`
per ADR-0007. The decimal string preserves bigint precision across
`JSON.stringify` for amounts beyond `Number.MAX_SAFE_INTEGER`.

## Guest-merge behavior

`mergeGuestIntoCustomer(guestCartId, customerId)`:

1. Refuses if the guest cart already has a `customerId` (use the customer
   cart directly — calling merge would be a programmer error).
2. Refuses if the guest cart status is not `active`.
3. If the customer has no active cart, **re-binds the guest cart** in place
   (sets `customer_id`). No copy, no second cart.
4. Otherwise, copies/merges line items into the customer's active cart
   (same variant ⇒ summed quantity, customer's existing `unit_price`
   wins) and marks the guest cart `status='converted'`.
5. Currencies must match between the two carts.

We chose **mark `converted`** over **delete** for the source guest cart so
operators retain an audit trail of "this cart became part of that one".
The `cart_items` cascade keeps the row referentially clean.

## Cross-module writes

Per ADR-0005 the cart module is the sole owner of the `carts` and
`cart_items` tables — but the checkout module makes one explicit,
documented exception: setting `carts.status='converted'` from inside
`checkout.complete()` so the cart→order transition is atomic with the
order_intent insert. The write is performed directly by the checkout
repository's `markCartConverted` (see
`apps/api/src/modules/checkout/repository.ts`), not via `cartService`,
because routing through the cart module would split the atomic unit
across two transactions.

## Follow-ups (out of scope this round)

- Stock reservation / inventory hold on add — currently the cart does not
  decrement `inventory_levels.available`. The checkout module will reserve
  on transition.
- Real tax module — replace the `TAX_PPN_RATE` placeholder with per-item /
  per-region / per-exemption selection.
- Shipping calculation — the shipping module plugs into the `shipping`
  slot in `CartTotals`.
- Cart sweep job — delete or mark abandoned carts past `expires_at`. The
  index is already in place; the BullMQ job lands later.
- Discount / promotion lines — `CartTotals` will gain a `discount` field
  when the promotion module ships.
- Per-cart customer-supplied currency override — currently the storefront
  passes the currency on cart create.
