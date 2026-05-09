/**
 * cart-actions — provider-free cart mutations for islands that don't own
 * a `CartProvider` subtree.
 *
 * Why a standalone helper?
 *
 *   The grid surfaces (home, /products, search) render dozens of product
 *   cards. Mounting a `CartProvider` per card would mean N React trees,
 *   each running its own cart hydrate effect on first render — a lot of
 *   wasted work for a button that may never be clicked. `QuickAddButton`
 *   is `client:visible`, so even just hydrating the React shell is the
 *   smallest unit of work we want to pay for; a full provider tree per
 *   card on top of that is wrong.
 *
 *   This module exposes a small, imperative `addLineItem` that:
 *     1. Reuses the same `localStorage` cart id that `CartProvider` writes
 *        (`mt.cartId`) so the two islands agree on the cart.
 *     2. Calls the same SDK paths CartProvider uses (`cart.create`,
 *        `cart.addItem`) directly.
 *     3. Broadcasts the same `mt:cart-changed` event CartProvider
 *        broadcasts, so every other island (header badge, drawer, /cart
 *        page) re-hydrates exactly the way it does on a CartProvider-driven
 *        add. The drawer auto-open is decided per-caller — QuickAdd skips
 *        it (browse-flow add) while PDP "Add to cart" still triggers it
 *        via `CartProvider.openDrawer()`.
 *
 * `CartProvider.addItem` is refactored on top of this helper so the wire
 * format and event shape stay identical between the two paths — there is
 * exactly one place that knows how to mutate the guest cart.
 */
import { createClient, type Cart } from "@mt-commerce/sdk";
import { rememberProductInfo, type ProductInfo } from "./cart-product-info.js";

const STORAGE_KEY = "mt.cartId";
const CART_CHANGED_EVENT = "mt:cart-changed";

/** Single-source-of-truth currency for v0.1; mirrors CartProvider. */
const DEFAULT_CURRENCY = "IDR";

/**
 * Detail payload broadcast on `mt:cart-changed`. Mirrors
 * `CartProvider`'s `CartChangedDetail` so listeners cannot tell whether
 * the change came from a quick-add or a PDP add.
 */
export interface CartChangedDetail {
  delta: number;
  itemCount: number;
  variantId: string | null;
}

function readCartId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Privacy-mode storage access can throw; treat as no persisted cart.
    return null;
  }
}

function writeCartId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Same rationale as readCartId — silently swallow.
  }
}

function broadcastCartChange(detail: CartChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CartChangedDetail>(CART_CHANGED_EVENT, { detail }),
  );
}

function totalQuantity(cart: Cart | null): number {
  if (!cart) return 0;
  let n = 0;
  for (const item of cart.items) n += item.quantity;
  return n;
}

export interface AddLineItemInput {
  /** API base URL — caller resolves via `resolveApiUrl()` from `lib/api.ts`. */
  apiUrl: string;
  /**
   * Existing cart id, if known. Pass `null` if the caller has no cart
   * id; the helper will create one and persist it.
   */
  cartId: string | null;
  variantId: string;
  quantity: number;
  currency?: string;
  /**
   * Locale-resolved product info for the line. The cart wire shape does
   * not carry title or image yet, so the call site (PDP, quick-add)
   * passes what it already has on hand and we cache it under `variantId`
   * via `cart-product-info`. Renderers (drawer, /cart) read the cached
   * entry to show a real title instead of the raw variant id.
   */
  productInfo?: ProductInfo;
}

export interface AddLineItemResult {
  cartId: string;
  itemCount: number;
  delta: number;
  /** Updated cart, for callers (e.g. `CartProvider`) that mirror it in state. */
  cart: Cart;
}

/**
 * Add a line item to the guest cart. Creates the cart if needed,
 * persists the id to localStorage, and broadcasts the change so other
 * islands re-render. Throws on transport / API failure — callers
 * surface the error (`QuickAddButton` shows an inline error label,
 * `CartProvider.addItem` propagates so `AddToCartButton` can flip its
 * state).
 *
 * The helper does NOT open the drawer — the caller decides. PDP "Add to
 * cart" opens it (deliberate, user is committed to the product); QuickAdd
 * does not (browse-flow add).
 */
export async function addLineItem(
  input: AddLineItemInput,
): Promise<AddLineItemResult> {
  const { apiUrl, variantId, quantity, productInfo } = input;
  const currency = input.currency ?? DEFAULT_CURRENCY;
  const client = createClient({ baseUrl: apiUrl });

  // Cache product info ahead of the network call so the drawer has a
  // real title to render even if the add hops through a slow connection.
  if (productInfo) rememberProductInfo(variantId, productInfo);

  // Resolve cart id: prefer the caller's hint, fall back to localStorage.
  // The double-check keeps behavior consistent whether the caller has its
  // own state (CartProvider) or not (QuickAddButton).
  let cartId = input.cartId ?? readCartId();
  let beforeQuantity = 0;

  if (cartId === null) {
    const created = await client.storefront.cart.create({ currency });
    cartId = created.id;
    writeCartId(cartId);
    beforeQuantity = totalQuantity(created);
  } else {
    // Read the cart so we can compute an accurate delta. If the cart 404s
    // here (expired/wiped server-side) we recreate it transparently — the
    // user's tap should not bounce off a stale id.
    try {
      const existing = await client.storefront.cart.byId(cartId);
      beforeQuantity = totalQuantity(existing);
    } catch {
      const created = await client.storefront.cart.create({ currency });
      cartId = created.id;
      writeCartId(cartId);
      beforeQuantity = totalQuantity(created);
    }
  }

  const next = await client.storefront.cart.addItem(cartId, {
    variantId,
    quantity,
  });
  const after = totalQuantity(next);
  const delta = after - beforeQuantity;

  broadcastCartChange({ delta, itemCount: after, variantId });

  return { cartId, itemCount: after, delta, cart: next };
}
