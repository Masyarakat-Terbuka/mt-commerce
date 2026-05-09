/**
 * cart-product-info — frontend-only resolver for human-readable cart line
 * metadata.
 *
 * The cart wire shape (`packages/sdk` / `apps/api`) carries `variantId`,
 * quantity, and pricing — but no product title or image. Without those,
 * surfaces like the cart drawer fall back to rendering the variant id
 * verbatim, which reads as `var_01HXY9KZ3T...` to the visitor.
 *
 * This module provides the smallest possible workaround until the API
 * grows the fields:
 *
 *   - Add-to-cart call sites (PDP, ProductCard quick-add) already have
 *     the locale-resolved title and image URL in hand. They call
 *     `rememberProductInfo({ variantId, title, imageUrl, imageAlt })`
 *     when adding a line.
 *   - Renderers (drawer, /cart page) call `getProductInfo(variantId)`
 *     to look up the cached entry; missing entries fall back to a
 *     generic label so a row never reads as a meaningless ID.
 *
 * Persistence: the map lives in `localStorage` under `mt.variantInfo`,
 * keyed by `variantId`. localStorage is the right scope — the cart id
 * already lives there and pairs with this map; the entries should
 * outlive a single page navigation so the drawer's contents remain
 * legible after a refresh or a return visit.
 *
 * Bound: the cache is capped at 200 entries with simple FIFO eviction
 * (oldest insert evicted first). Carts in the wild won't approach this,
 * but the cap protects long-lived devices from unbounded growth.
 *
 * Cross-island sync: writers dispatch `mt:variant-info-changed` on
 * `window` after each persist. Mounted islands listen and force a
 * re-render so a freshly added line shows the correct title without
 * waiting for the next mount.
 */

const STORAGE_KEY = "mt.variantInfo";
const CHANGED_EVENT = "mt:variant-info-changed";
const MAX_ENTRIES = 200;

export interface ProductInfo {
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
}

interface PersistedShape {
  /** Insertion-order list of variant ids; `[0]` is the oldest. */
  order: string[];
  byVariantId: Record<string, ProductInfo>;
}

function emptyShape(): PersistedShape {
  return { order: [], byVariantId: {} };
}

function readShape(): PersistedShape {
  if (typeof window === "undefined") return emptyShape();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyShape();
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (
      !parsed ||
      !Array.isArray(parsed.order) ||
      typeof parsed.byVariantId !== "object" ||
      parsed.byVariantId === null
    ) {
      return emptyShape();
    }
    // Defensive: drop entries not in the order list and vice versa.
    const byVariantId: Record<string, ProductInfo> = {};
    const order: string[] = [];
    for (const id of parsed.order) {
      const entry = parsed.byVariantId[id];
      if (entry && typeof entry.title === "string") {
        byVariantId[id] = {
          title: entry.title,
          imageUrl: entry.imageUrl ?? null,
          imageAlt: entry.imageAlt ?? null,
        };
        order.push(id);
      }
    }
    return { order, byVariantId };
  } catch {
    return emptyShape();
  }
}

function writeShape(shape: PersistedShape): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Storage may throw in privacy mode or when full; treat as a soft
    // failure — the cart drawer will fall through to its variant-id
    // fallback for entries we can't persist.
  }
}

export function rememberProductInfo(
  variantId: string,
  info: ProductInfo,
): void {
  if (typeof window === "undefined") return;
  if (!variantId) return;
  const shape = readShape();
  if (variantId in shape.byVariantId) {
    // Refresh value but keep insertion order — translations or images may
    // have changed between sessions and we want the latest.
    shape.byVariantId[variantId] = info;
  } else {
    shape.order.push(variantId);
    shape.byVariantId[variantId] = info;
    while (shape.order.length > MAX_ENTRIES) {
      const evictId = shape.order.shift();
      if (evictId !== undefined) delete shape.byVariantId[evictId];
    }
  }
  writeShape(shape);
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function getProductInfo(variantId: string): ProductInfo | null {
  const shape = readShape();
  return shape.byVariantId[variantId] ?? null;
}

/** Event name fired on `window` after `rememberProductInfo` writes. */
export const PRODUCT_INFO_CHANGED_EVENT = CHANGED_EVENT;
