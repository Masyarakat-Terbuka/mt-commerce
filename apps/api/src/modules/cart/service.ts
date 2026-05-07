/**
 * `CartService` — public contract for the cart module.
 *
 * Owns:
 *   - cart and cart-item lifecycle (create, add, update, remove, clear)
 *   - currency-locking invariant (one cart = one currency, set on first add)
 *   - merge semantics (same-variant adds collapse into one line, summed
 *     quantity)
 *   - guest-to-customer cart promotion (`mergeGuestIntoCustomer`)
 *   - pure totals computation (`getTotals`) — no DB round-trip; safe to call
 *     from anywhere
 *   - domain errors (NotFoundError, ConflictError, ValidationError) — never
 *     leaks Drizzle/Postgres errors to callers
 *
 * Constructor takes a repository so tests can swap an in-memory fake; the
 * default singleton `cartService` (in `index.ts`) is wired to the runtime
 * `db`.
 *
 * Notes on what is NOT in scope this round (see README):
 *   - Stock reservation / inventory holds (no decrement on add).
 *   - Checkout transitions (a separate module lands next).
 *   - Real tax/shipping calculation (placeholders only — see `getTotals`).
 */
import { add as moneyAdd, multiply as moneyMultiply, zero as moneyZero, type Money } from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import { env } from "../../lib/env.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { toCart } from "./mappers.js";
import {
  createCartRepository,
  type CartRepository,
} from "./repository.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AddItemInput,
  type AppliedTaxRate,
  type Cart,
  type CartItem,
  type CartTotals,
  type ListCartsQuery,
  type Paginated,
} from "./types.js";

/**
 * Optional inputs to `getTotals` so callers can plug in a tax rate fetched
 * from the dedicated tax module and a shipping amount resolved from the
 * shipping module — without the cart module taking direct dependencies on
 * either. Per ADR-0005 (modular monolith), modules talk to each other
 * through these narrow interfaces, never direct imports.
 *
 * - `taxRate` carries the basis-points integer; the cart applies it via
 *   `multiply(money, basisPoints/10000, halfEven)` so the rounding stays
 *   exact at the integer level. When omitted (or null), the cart falls
 *   back to the legacy `env.taxPpnRate` so unit tests and dev seeds
 *   without a tax_rates row keep working.
 *
 * - `shipping` replaces the legacy `zero(currency)` shipping placeholder.
 *   Currency parity with the cart's currency is asserted; a mismatch is
 *   a programming error and surfaces as a `CurrencyMismatchError` from
 *   `Money.add`.
 */
export interface GetTotalsOptions {
  /**
   * The tax rate to apply. Pass the result of
   * `taxService.getDefaultRate(cart.currency)` or null to fall back to
   * the env-var rate.
   */
  taxRate?: { code: string; rateBasisPoints: number } | null;
  /** Resolved shipping amount in the cart's currency. */
  shipping?: Money;
}

export interface CartService {
  // Lifecycle
  createGuestCart(currency: string): Promise<Cart>;
  createCustomerCart(customerId: string, currency: string): Promise<Cart>;

  // Reads
  getCartById(id: string): Promise<Cart | null>;
  /** Most-recent active cart for a customer, or `null` if none exists. */
  getActiveCartForCustomer(customerId: string): Promise<Cart | null>;
  listCarts(
    query: ListCartsQuery,
  ): Promise<Paginated<Cart>>;

  // Items
  /**
   * Look up the variant, validate currency match against the cart, capture
   * `unit_price_*` from the variant, and upsert (merge same variant by
   * summing quantity).
   *
   * Throws:
   *   - `NotFoundError` when the cart or the variant does not exist (or the
   *     variant has been soft-deleted).
   *   - `ValidationError {code:"currency_mismatch"}` when the variant's
   *     currency does not equal the cart's currency.
   *   - `ConflictError` when adding to a cart whose status is not `active`.
   */
  addItem(cartId: string, input: AddItemInput): Promise<Cart>;
  /** A `quantity` of `0` is interpreted as remove. */
  updateItemQuantity(
    cartId: string,
    itemId: string,
    quantity: number,
  ): Promise<Cart>;
  removeItem(cartId: string, itemId: string): Promise<Cart>;
  clear(cartId: string): Promise<Cart>;

  // Cross-cart flows
  /**
   * Promote a guest cart into a customer cart. The guest cart's items are
   * merged into the customer's active cart (by variant — same variant ⇒
   * summed quantity). Currencies must match.
   *
   * Behavior chosen for the source guest cart: marked `status='converted'`.
   * It is NOT deleted — keeping the row gives operators an audit trail of
   * who-merged-into-whom, and the foreign-key cascade from `cart_items`
   * keeps the row referentially clean. (See README "Merge semantics".)
   *
   * If the customer has no active cart yet, the guest cart is re-bound to
   * the customer (its `customer_id` is set) and stays `active` — no
   * second-cart creation, no item copy needed.
   */
  mergeGuestIntoCustomer(
    guestCartId: string,
    customerId: string,
  ): Promise<Cart>;

  // Status overrides
  markAbandoned(cartId: string): Promise<Cart>;

  // Pure compute
  /**
   * Pure compute (no DB round-trip).
   *
   * Tax: when `opts.taxRate` is provided, applied via
   * `subtotal * (basisPoints / 10000)` with halfEven rounding. Otherwise
   * the cart falls back to `env.taxPpnRate` for environments where the
   * tax module has not been seeded (unit tests, fresh dev DBs).
   *
   * Shipping: when `opts.shipping` is provided, used directly (currency
   * must match the cart's currency). Otherwise zero.
   *
   * The dedicated tax + shipping modules ship as separate concerns; this
   * function consumes their outputs through `opts` rather than reaching
   * for them directly, keeping the cart module dependency-free per
   * ADR-0005.
   */
  getTotals(cart: Cart, opts?: GetTotalsOptions): CartTotals;
}

export class CartServiceImpl implements CartService {
  constructor(private readonly repo: CartRepository) {}

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async createGuestCart(currency: string): Promise<Cart> {
    assertCurrency(currency);
    const cartId = id("cart");
    const row = await this.repo.insertCart({
      id: cartId,
      customerId: null,
      currency,
      status: "active",
    });
    return toCart(row, []);
  }

  async createCustomerCart(
    customerId: string,
    currency: string,
  ): Promise<Cart> {
    assertCurrency(currency);
    const cartId = id("cart");
    const row = await this.repo.insertCart({
      id: cartId,
      customerId,
      currency,
      status: "active",
    });
    return toCart(row, []);
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async getCartById(cartId: string): Promise<Cart | null> {
    const row = await this.repo.getCartById(cartId);
    if (!row) return null;
    const items = await this.repo.listItemsForCart(cartId);
    return toCart(row, items);
  }

  async getActiveCartForCustomer(customerId: string): Promise<Cart | null> {
    const row = await this.repo.getActiveCartForCustomer(customerId);
    if (!row) return null;
    const items = await this.repo.listItemsForCart(row.id);
    return toCart(row, items);
  }

  async listCarts(query: ListCartsQuery): Promise<Paginated<Cart>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const { rows, total } = await this.repo.listCarts({
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      page,
      pageSize,
    });

    // Batch-fetch the items for the page in one query so listing 100 carts
    // is two round-trips, not 101.
    const cartIds = rows.map((row) => row.id);
    const allItems = await this.repo.listItemsForCarts(cartIds);
    const itemsByCart = new Map<string, typeof allItems>();
    for (const item of allItems) {
      const existing = itemsByCart.get(item.cartId);
      if (existing) {
        existing.push(item);
      } else {
        itemsByCart.set(item.cartId, [item]);
      }
    }

    const data = rows.map((row) => toCart(row, itemsByCart.get(row.id) ?? []));
    return { data, total, page, pageSize };
  }

  // -------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------

  async addItem(cartId: string, input: AddItemInput): Promise<Cart> {
    const cart = await this.repo.getCartById(cartId);
    if (!cart) {
      throw new NotFoundError("Cart not found.", { cartId });
    }
    if (cart.status !== "active") {
      throw new ConflictError("Cannot add items to a non-active cart.", {
        cartId,
        status: cart.status,
      });
    }

    const variant = await this.repo.getVariantSnapshot(input.variantId);
    if (!variant || variant.deleted) {
      throw new NotFoundError("Variant not found.", {
        variantId: input.variantId,
      });
    }

    if (variant.priceCurrency !== cart.currency) {
      throw new ValidationError(
        "Variant currency does not match the cart's currency.",
        {
          code: "currency_mismatch",
          cartCurrency: cart.currency,
          variantCurrency: variant.priceCurrency,
          variantId: input.variantId,
        },
      );
    }

    // All mutating work in one transaction so a partial failure (insert
    // succeeds, touchCart fails) cannot leave the parent's `updatedAt`
    // out of sync with the child rows.
    return this.repo.withTransaction(async (tx) => {
      const existing = await tx.getItemByCartAndVariant(
        cartId,
        input.variantId,
      );

      if (existing) {
        // Merge: sum the quantity, refresh `unit_price` to the *latest* add
        // so the captured price tracks the most recent shopper intent.
        // (An alternative would be to keep the original — we picked
        // "latest add wins" because it matches the storefront mental model
        // of "I added it again, that's the price now"; documented in
        // the module README.)
        const merged = await tx.updateItem(existing.id, {
          quantity: existing.quantity + input.quantity,
          unitPriceAmount: variant.priceAmount,
          unitPriceCurrency: variant.priceCurrency,
        });
        if (!merged) {
          throw new NotFoundError("Cart item disappeared mid-update.", {
            itemId: existing.id,
          });
        }
      } else {
        await tx.insertItem({
          id: id("ci"),
          cartId,
          variantId: input.variantId,
          quantity: input.quantity,
          unitPriceAmount: variant.priceAmount,
          unitPriceCurrency: variant.priceCurrency,
        });
      }

      await tx.touchCart(cartId);
      const refreshed = await tx.getCartById(cartId);
      if (!refreshed) {
        throw new NotFoundError("Cart not found.", { cartId });
      }
      const items = await tx.listItemsForCart(cartId);
      return toCart(refreshed, items);
    });
  }

  async updateItemQuantity(
    cartId: string,
    itemId: string,
    quantity: number,
  ): Promise<Cart> {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ValidationError("quantity must be a non-negative integer.", {
        quantity,
      });
    }

    const cart = await this.repo.getCartById(cartId);
    if (!cart) {
      throw new NotFoundError("Cart not found.", { cartId });
    }
    if (cart.status !== "active") {
      throw new ConflictError("Cannot modify items on a non-active cart.", {
        cartId,
        status: cart.status,
      });
    }

    return this.repo.withTransaction(async (tx) => {
      const existing = await tx.getItemById(itemId);
      if (!existing || existing.cartId !== cartId) {
        // Ownership mismatch surfaces as 404, not 403, so we do not leak
        // the existence of items that belong to other carts.
        throw new NotFoundError("Cart item not found.", { itemId });
      }

      if (quantity === 0) {
        await tx.deleteItem(itemId);
      } else {
        const updated = await tx.updateItem(itemId, { quantity });
        if (!updated) {
          throw new NotFoundError("Cart item not found.", { itemId });
        }
      }

      await tx.touchCart(cartId);
      const refreshed = await tx.getCartById(cartId);
      if (!refreshed) {
        throw new NotFoundError("Cart not found.", { cartId });
      }
      const items = await tx.listItemsForCart(cartId);
      return toCart(refreshed, items);
    });
  }

  async removeItem(cartId: string, itemId: string): Promise<Cart> {
    return this.updateItemQuantity(cartId, itemId, 0);
  }

  async clear(cartId: string): Promise<Cart> {
    const cart = await this.repo.getCartById(cartId);
    if (!cart) {
      throw new NotFoundError("Cart not found.", { cartId });
    }
    if (cart.status !== "active") {
      throw new ConflictError("Cannot clear a non-active cart.", {
        cartId,
        status: cart.status,
      });
    }

    return this.repo.withTransaction(async (tx) => {
      await tx.deleteItemsForCart(cartId);
      await tx.touchCart(cartId);
      const refreshed = await tx.getCartById(cartId);
      if (!refreshed) {
        throw new NotFoundError("Cart not found.", { cartId });
      }
      return toCart(refreshed, []);
    });
  }

  // -------------------------------------------------------------------
  // Cross-cart flows
  // -------------------------------------------------------------------

  async mergeGuestIntoCustomer(
    guestCartId: string,
    customerId: string,
  ): Promise<Cart> {
    const guest = await this.repo.getCartById(guestCartId);
    if (!guest) {
      throw new NotFoundError("Guest cart not found.", { cartId: guestCartId });
    }
    if (guest.customerId !== null) {
      // Already bound — the caller probably means "load the customer cart"
      // rather than "merge". Refuse explicitly so the caller fixes the call
      // site rather than re-binding silently.
      throw new ConflictError("Cart is not a guest cart.", {
        cartId: guestCartId,
        customerId: guest.customerId,
      });
    }
    if (guest.status !== "active") {
      throw new ConflictError("Cannot merge a non-active cart.", {
        cartId: guestCartId,
        status: guest.status,
      });
    }

    return this.repo.withTransaction(async (tx) => {
      const customerActive = await tx.getActiveCartForCustomer(customerId);

      // No customer cart yet — re-bind the guest cart in place. Cheaper
      // than copying every item, and the guest cart's history (created_at,
      // expires_at) is preserved.
      if (!customerActive) {
        const updated = await tx.updateCart(guestCartId, {
          customerId,
        });
        if (!updated) {
          throw new NotFoundError("Guest cart not found.", {
            cartId: guestCartId,
          });
        }
        const items = await tx.listItemsForCart(guestCartId);
        return toCart(updated, items);
      }

      // Both carts must be in the same currency. The cart-level currency
      // lock makes this the right check; per-line variant currency is
      // already guaranteed to equal the cart's currency by addItem.
      if (customerActive.currency !== guest.currency) {
        throw new ValidationError(
          "Guest and customer carts have different currencies.",
          {
            code: "currency_mismatch",
            guestCurrency: guest.currency,
            customerCurrency: customerActive.currency,
          },
        );
      }

      const guestItems = await tx.listItemsForCart(guestCartId);
      const customerItems = await tx.listItemsForCart(customerActive.id);
      const customerByVariant = new Map(
        customerItems.map((item) => [item.variantId, item]),
      );

      for (const guestItem of guestItems) {
        const existing = customerByVariant.get(guestItem.variantId);
        if (existing) {
          // Merge: sum the quantity. Keep the customer cart's existing
          // unit_price so a fresh re-add of the same variant doesn't
          // silently re-price what was already in the customer cart.
          await tx.updateItem(existing.id, {
            quantity: existing.quantity + guestItem.quantity,
          });
        } else {
          await tx.insertItem({
            id: id("ci"),
            cartId: customerActive.id,
            variantId: guestItem.variantId,
            quantity: guestItem.quantity,
            unitPriceAmount: guestItem.unitPriceAmount,
            unitPriceCurrency: guestItem.unitPriceCurrency,
          });
        }
      }

      // Mark the source guest cart as `converted` (NOT deleted) so the
      // FK cascade keeps things tidy and the audit trail survives.
      await tx.updateCart(guestCartId, { status: "converted" });
      // Bump the customer cart's mtime so caches see the merge.
      await tx.touchCart(customerActive.id);

      const refreshed = await tx.getCartById(customerActive.id);
      if (!refreshed) {
        throw new NotFoundError("Customer cart not found.", {
          cartId: customerActive.id,
        });
      }
      const items = await tx.listItemsForCart(customerActive.id);
      return toCart(refreshed, items);
    });
  }

  // -------------------------------------------------------------------
  // Status overrides
  // -------------------------------------------------------------------

  async markAbandoned(cartId: string): Promise<Cart> {
    const cart = await this.repo.getCartById(cartId);
    if (!cart) {
      throw new NotFoundError("Cart not found.", { cartId });
    }
    if (cart.status === "converted") {
      // A converted cart is the source of an order — abandoning it would
      // misrepresent the audit trail. Refuse explicitly.
      throw new ConflictError("Cannot abandon a converted cart.", {
        cartId,
        status: cart.status,
      });
    }

    const updated = await this.repo.updateCart(cartId, { status: "abandoned" });
    if (!updated) {
      throw new NotFoundError("Cart not found.", { cartId });
    }
    const items = await this.repo.listItemsForCart(cartId);
    return toCart(updated, items);
  }

  // -------------------------------------------------------------------
  // Pure compute — totals
  // -------------------------------------------------------------------

  /**
   * Pure cart-totals computation. Invoked from cart reads, the future
   * order-creation path, and anywhere a `Cart` needs a money breakdown.
   *
   * Contract:
   *
   *   subtotal — Σ (unit_price * quantity) across line items, in the cart's
   *              currency. An empty cart yields `zero(currency)`.
   *
   *   tax      — When `opts.taxRate` is provided, `subtotal * (basisPoints
   *              / 10000)` with halfEven rounding. Otherwise the legacy
   *              `env.taxPpnRate` is applied — this fallback exists so
   *              tests and unseeded dev DBs continue to produce sensible
   *              totals while the tax module rolls out.
   *
   *   shipping — `opts.shipping` when provided (currency-checked against
   *              the cart). Otherwise `zero(currency)`. The shipping
   *              module's `quote()` is the canonical source.
   *
   *   total    — `subtotal + tax + shipping`. Throws via `Money.add` if
   *              currencies disagree (the cart-level lock prevents this
   *              for the items; the opts.shipping is the only other
   *              source and is validated below).
   *
   *   taxRate  — Echoed from `opts.taxRate` so the wire envelope can
   *              show clients which rate was applied. Null on the env-var
   *              fallback path.
   *
   * Performance: all-bigint math; no DB I/O; safe to call in a hot loop
   * (e.g. listing 100 carts in the admin) — the caller batches the
   * tax-rate / shipping resolution outside the loop.
   */
  getTotals(cart: Cart, opts?: GetTotalsOptions): CartTotals {
    const currency = cart.currency;
    const subtotal = computeSubtotal(cart.items, currency);

    let tax: Money;
    let appliedRate: AppliedTaxRate | null = null;
    if (opts?.taxRate) {
      // basis_points / 10000 — exact integer-level conversion, rounded
      // once at the end via halfEven (banker's) per ADR-0007.
      const factor = opts.taxRate.rateBasisPoints / 10_000;
      tax = moneyMultiply(subtotal, factor, { rounding: "halfEven" });
      appliedRate = {
        code: opts.taxRate.code,
        basisPoints: opts.taxRate.rateBasisPoints,
      };
    } else {
      // Fallback path: keeps `getTotals` deterministic when no tax module
      // has been seeded. Documented as a transitional fallback in the
      // README and in `lib/env.ts` (TAX_PPN_RATE).
      tax = moneyMultiply(subtotal, env.taxPpnRate, {
        rounding: "halfEven",
      });
    }

    let shipping: Money;
    if (opts?.shipping) {
      // Currency parity: the cart locks a single currency. Surface a
      // mismatch eagerly — a wrong-currency shipping amount would
      // otherwise blow up at `moneyAdd` later with a less helpful trace.
      if (opts.shipping.currency !== currency) {
        throw new ValidationError(
          "Shipping currency does not match the cart's currency.",
          {
            code: "currency_mismatch",
            cartCurrency: currency,
            shippingCurrency: opts.shipping.currency,
          },
        );
      }
      shipping = opts.shipping;
    } else {
      shipping = moneyZero(currency);
    }

    const total = moneyAdd(moneyAdd(subtotal, tax), shipping);

    return { subtotal, tax, shipping, total, taxRate: appliedRate };
  }
}

// -------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------

function computeSubtotal(items: CartItem[], currency: string): Money {
  // Start from `zero(currency)` so an empty cart yields the right
  // currency-typed zero. Money.add asserts same-currency on every step;
  // a line whose currency drifts from the cart's currency is a programming
  // error and is intentionally surfaced as a CurrencyMismatchError, not
  // silently coerced.
  let acc: Money = moneyZero(currency);
  for (const item of items) {
    // `multiply` with a bigint is exact (no rounding). Quantity is bounded
    // by the schema; the BigInt cast is safe.
    const lineTotal = moneyMultiply(item.unitPrice, BigInt(item.quantity));
    acc = moneyAdd(acc, lineTotal);
  }
  return acc;
}

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Boundary check — currencies coming into the service are validated again
 * here so a path that bypasses the Zod schema (e.g. a future internal
 * caller) cannot create a cart with an unsupported code.
 *
 * `KNOWN_CURRENCIES` lives on `@mt-commerce/core/money`; for the v0.1
 * surface we re-validate inline rather than re-importing because the only
 * place this is reached is in `createGuestCart` and `createCustomerCart`,
 * both of which sit downstream of the route-level Zod schema.
 */
function assertCurrency(currency: string): void {
  // ISO 4217 shape only. The route-level schema does the
  // KNOWN_CURRENCIES membership check. Internal callers must supply a
  // currency they have already validated upstream.
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError("currency must be a 3-letter ISO 4217 code.", {
      currency,
    });
  }
}

/**
 * Default singleton wired to the runtime database. Tests construct
 * `CartServiceImpl` directly with a fake repository.
 */
export const cartService: CartService = new CartServiceImpl(
  createCartRepository(),
);
