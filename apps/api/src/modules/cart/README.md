# Cart module

Owns shopping carts and cart line items, plus pure totals computation.
Per ADR-0005 no other module reads or writes cart tables directly —
cross-module callers go through `cartService`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table        | Purpose                                          | ID prefix |
| ------------ | ------------------------------------------------ | --------- |
| `carts`      | Cart header (currency lock, status, expiry)      | `cart_`   |
| `cart_items` | Line items: `(cart, variant) → quantity, price`  | `ci_`     |

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
  updateItemQuantity(cartId, itemId, quantity): Promise<Cart>;  // 0 ⇒ remove
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

| Method | Path                       | Purpose                       |
| ------ | -------------------------- | ----------------------------- |
| GET    | `/carts`                   | List + filter + paginate      |
| GET    | `/carts/:id`               | Detail (with totals)          |
| POST   | `/carts/:id/abandon`       | Mark abandoned (override)     |

### Storefront (`/storefront/v1`)

| Method | Path                                | Auth      |
| ------ | ----------------------------------- | --------- |
| POST   | `/carts`                            | public    |
| GET    | `/carts/:id`                        | public    |
| POST   | `/carts/:id/items`                  | public    |
| PATCH  | `/carts/:id/items/:itemId`          | public    |
| DELETE | `/carts/:id/items/:itemId`          | public    |
| POST   | `/carts/:id/clear`                  | public    |
| GET    | `/customer/me/cart`                 | TODO auth |
| POST   | `/customer/me/cart`                 | TODO auth |

#### Auth gating — TODO

The `/customer/me/cart` endpoints accept a stand-in `x-customer-id` header
while the auth integration on the storefront side is finalized. The customer
module uses the same pattern; both will switch to `c.var.authUser`-derived
resolution once the storefront's auth wiring lands. The public cart routes
treat the cart's ULID as the bearer — anyone with the id can act on the
cart, which mirrors the typical guest-cart flow shoppers expect.

## Totals semantics

`getTotals(cart)` is pure (no DB I/O). It computes:

| Field    | Computation                                                |
| -------- | ---------------------------------------------------------- |
| subtotal | Σ (`unit_price * quantity`) across line items              |
| tax      | `subtotal * TAX_PPN_RATE`, rounded `halfEven`              |
| shipping | `zero(currency)` (placeholder — shipping module plugs in)  |
| total    | `subtotal + tax + shipping`                                |

`TAX_PPN_RATE` defaults to `0.11` (Indonesian PPN, 11%). It lives in the
environment so operators can dial it without a code change while the proper
tax module is being built. The dedicated tax module (see
`docs/v0.1-checklist.md` "Tax") will replace this placeholder with proper
per-item / per-region / per-exemption rate selection driven by the
`tax_rates` and `tax_exemptions` tables.

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

## Follow-ups (out of scope this round)

- Stock reservation / inventory hold on add — currently the cart does not
  decrement `inventory_levels.available`. The checkout module will reserve
  on transition.
- Real tax module — replace the `TAX_PPN_RATE` placeholder with per-item /
  per-region / per-exemption selection.
- Shipping calculation — the shipping module plugs into the `shipping`
  slot in `CartTotals`.
- Auth-derived current customer (drop the `x-customer-id` storefront
  stand-in header).
- Cart sweep job — delete or mark abandoned carts past `expires_at`. The
  index is already in place; the BullMQ job lands later.
- Discount / promotion lines — `CartTotals` will gain a `discount` field
  when the promotion module ships.
- Per-cart customer-supplied currency override — currently the storefront
  passes the currency on cart create.
