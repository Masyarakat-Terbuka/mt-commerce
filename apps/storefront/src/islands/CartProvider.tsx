/**
 * CartProvider — small React context that owns the guest cart for the storefront.
 *
 * Persistence model — pragmatic for v0.1:
 *
 *   - The guest cart id lives in `localStorage` under `mt.cartId`. On mount we
 *     read it, and if present, fetch the cart through the SDK to hydrate state.
 *   - A 404 / not_found from the API means the cart has expired or was wiped;
 *     we clear the localStorage key and fall back to "no cart yet".
 *   - First add-to-cart creates a guest cart with `currency: "IDR"`, persists
 *     the new id, and then performs the addItem call. Currency is fixed at
 *     IDR for v0.1 — the storefront ships rupiah-only at this milestone.
 *
 * Cross-island sharing — Astro mounts each island in its own React tree. To
 * keep multiple islands (header badge, drawer, /cart page, AddToCartButton)
 * in sync, this provider:
 *
 *   1. Stores `cartId` in localStorage so every island agrees on the id.
 *   2. Broadcasts state updates over a `mt:cart-changed` CustomEvent on the
 *      `window` so islands without a shared React tree can re-render. This
 *      keeps the API surface (`useCart()`) familiar without forcing a single
 *      root island wrapping the whole page (which Astro's slot model doesn't
 *      support cleanly across pages).
 *
 * The drawer-open signal travels on `mt:cart-open` (a separate event) so the
 * AddToCartButton can ask the drawer to slide in after a successful add
 * without coupling the two islands directly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, createClient, type Cart } from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";

const STORAGE_KEY = "mt.cartId";
const CART_CHANGED_EVENT = "mt:cart-changed";
const CART_OPEN_EVENT = "mt:cart-open";

/** Single-source-of-truth currency for v0.1. */
const DEFAULT_CURRENCY = "IDR";

/**
 * Module-level cache of the most recently observed cart. Survives island
 * remount across `ClientRouter` view-transition swaps so the header badge
 * doesn't blink to zero between pages while the network refresh runs.
 *
 * Lives on the JS module rather than `window` so test harnesses that
 * import the file get a fresh slate per import. The localStorage cart id
 * remains the cross-tab source of truth; this snapshot is purely an
 * in-memory hint for synchronous re-render after a swap.
 */
let cachedCart: Cart | null = null;

export interface CartContextValue {
  cart: Cart | null;
  loading: boolean;
  error: string | null;
  /** Sum of item quantities — what the header badge displays. */
  itemCount: number;
  addItem: (variantId: string, quantity?: number) => Promise<void>;
  updateItem: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  clear: () => Promise<void>;
  /** Imperatively open the drawer (used by AddToCartButton on success). */
  openDrawer: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function readPersistedCartId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Some browsers throw on storage access in privacy modes; treat it as
    // "no persisted cart" rather than crash the island.
    return null;
  }
}

function writePersistedCartId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  } catch {
    // Same rationale as readPersistedCartId — silently swallow.
  }
}

/**
 * Detail payload broadcast on `mt:cart-changed`. Listeners that only need
 * to refresh state can ignore it; the count badge uses `delta` to decide
 * whether to play the bump animation (positive delta = a successful add).
 */
export interface CartChangedDetail {
  /** Item-count delta. Positive on `addItem`, negative on remove/clear. */
  delta: number;
  /** New total quantity in the cart after the change. */
  itemCount: number;
  /**
   * The variant the change was about, if known. Used by the drawer to
   * highlight the just-added line. Optional — clears/removes don't always
   * have a meaningful variant id (e.g. "clear" sets it to null).
   */
  variantId: string | null;
}

function broadcastCartChange(detail: CartChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CartChangedDetail>(CART_CHANGED_EVENT, { detail }),
  );
}

export function openCartDrawer(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CART_OPEN_EVENT));
}

export interface CartProviderProps {
  children: ReactNode;
  /** Override for tests; production reads from `PUBLIC_API_URL`. */
  apiUrl?: string;
}

/**
 * `CartProvider` wraps the React subtree of a single island. Multiple islands
 * each create their own provider; cross-island synchrony comes via the
 * `mt:cart-changed` window event (broadcast by every mutation) plus the shared
 * `localStorage` cart id.
 */
export function CartProvider({ children, apiUrl }: CartProviderProps) {
  // Seed from the module cache so a remount across a ClientRouter swap
  // shows the previous cart (and badge count) immediately. The hydrate
  // effect below will refresh in the background if a persisted id exists.
  const [cart, setCart] = useState<Cart | null>(() => cachedCart);
  // When we already have a cached cart, don't flip to "loading" — the UI
  // would briefly read as empty otherwise. The hydrate effect promotes
  // `loading` to false on completion regardless.
  const [loading, setLoading] = useState<boolean>(() => cachedCart === null);
  const [error, setError] = useState<string | null>(null);

  // Keep `cartId` in a ref AND in localStorage. The ref lets callers read the
  // current id without a re-render; localStorage is the cross-tab source of
  // truth.
  const cartIdRef = useRef<string | null>(null);

  const client = useMemo(
    () => createClient({ baseUrl: apiUrl ?? resolveApiUrl() }),
    [apiUrl],
  );

  // Wrap state setter so the module cache stays in step with React state.
  // Subsequent islands mounting after a ClientRouter swap read the cache
  // synchronously and avoid the badge flicker that an empty initial render
  // would produce.
  const updateCart = useCallback((next: Cart | null) => {
    cachedCart = next;
    setCart(next);
  }, []);

  // Hydrate from localStorage on mount; refresh whenever another island
  // signals a change.
  useEffect(() => {
    let cancelled = false;

    async function hydrate(): Promise<void> {
      const persistedId = readPersistedCartId();
      cartIdRef.current = persistedId;
      if (!persistedId) {
        if (!cancelled) {
          updateCart(null);
          setLoading(false);
        }
        return;
      }
      try {
        const fetched = await client.storefront.cart.byId(persistedId);
        if (cancelled) return;
        updateCart(fetched);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        // Cart expired or was wiped on the server — drop the persisted id.
        if (err instanceof ApiError && err.code === "not_found") {
          writePersistedCartId(null);
          cartIdRef.current = null;
          updateCart(null);
          setLoading(false);
          return;
        }
        // Network/transport failure — keep the id, just surface the error.
        // The next mutation attempt will retry.
        setError(err instanceof Error ? err.message : "cart_load_failed");
        setLoading(false);
      }
    }

    void hydrate();

    function onChanged() {
      void hydrate();
    }
    window.addEventListener(CART_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(CART_CHANGED_EVENT, onChanged);
    };
  }, [client, updateCart]);

  // Ensure a cart exists; returns the id for use by the caller. Persistence
  // is updated synchronously so a refresh mid-flight still finds the cart.
  const ensureCart = useCallback(async (): Promise<string> => {
    if (cartIdRef.current) return cartIdRef.current;
    const created = await client.storefront.cart.create({
      currency: DEFAULT_CURRENCY,
    });
    cartIdRef.current = created.id;
    writePersistedCartId(created.id);
    updateCart(created);
    return created.id;
  }, [client, updateCart]);

  // Total quantity helper. Used to compute deltas before/after a
  // mutation so the broadcast carries the change the badge needs to
  // decide whether to bump.
  const totalQuantity = useCallback((c: Cart | null): number => {
    if (!c) return 0;
    let n = 0;
    for (const item of c.items) n += item.quantity;
    return n;
  }, []);

  const addItem = useCallback(
    async (variantId: string, quantity = 1) => {
      setError(null);
      setLoading(true);
      const before = totalQuantity(cart);
      try {
        const id = await ensureCart();
        const next = await client.storefront.cart.addItem(id, {
          variantId,
          quantity,
        });
        updateCart(next);
        const after = totalQuantity(next);
        broadcastCartChange({
          delta: after - before,
          itemCount: after,
          variantId,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "cart_add_failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [cart, client, ensureCart, totalQuantity, updateCart],
  );

  const updateItem = useCallback(
    async (itemId: string, quantity: number) => {
      const id = cartIdRef.current;
      if (!id) return;
      setError(null);
      setLoading(true);
      const before = totalQuantity(cart);
      const variantId =
        cart?.items.find((i) => i.id === itemId)?.variantId ?? null;
      try {
        const next = await client.storefront.cart.updateItem(id, itemId, {
          quantity,
        });
        updateCart(next);
        const after = totalQuantity(next);
        broadcastCartChange({
          delta: after - before,
          itemCount: after,
          variantId,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "cart_update_failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [cart, client, totalQuantity, updateCart],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      const id = cartIdRef.current;
      if (!id) return;
      setError(null);
      setLoading(true);
      const before = totalQuantity(cart);
      const variantId =
        cart?.items.find((i) => i.id === itemId)?.variantId ?? null;
      try {
        const next = await client.storefront.cart.removeItem(id, itemId);
        updateCart(next);
        const after = totalQuantity(next);
        broadcastCartChange({
          delta: after - before,
          itemCount: after,
          variantId,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "cart_remove_failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [cart, client, totalQuantity, updateCart],
  );

  const clear = useCallback(async () => {
    const id = cartIdRef.current;
    if (!id) return;
    setError(null);
    setLoading(true);
    const before = totalQuantity(cart);
    try {
      const next = await client.storefront.cart.clear(id);
      updateCart(next);
      const after = totalQuantity(next);
      broadcastCartChange({
        delta: after - before,
        itemCount: after,
        variantId: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "cart_clear_failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [cart, client, totalQuantity, updateCart]);

  const itemCount = useMemo(() => {
    if (!cart) return 0;
    let n = 0;
    for (const item of cart.items) n += item.quantity;
    return n;
  }, [cart]);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      loading,
      error,
      itemCount,
      addItem,
      updateItem,
      removeItem,
      clear,
      openDrawer: openCartDrawer,
    }),
    [cart, loading, error, itemCount, addItem, updateItem, removeItem, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error("useCart must be used inside <CartProvider>.");
  }
  return ctx;
}

/** Event name for cross-island drawer-open coordination. */
export const CART_OPEN_EVENT_NAME = CART_OPEN_EVENT;
/** Event name for cross-island state-changed broadcasts. */
export const CART_CHANGED_EVENT_NAME = CART_CHANGED_EVENT;
