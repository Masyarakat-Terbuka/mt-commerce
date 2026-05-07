/**
 * variant-store — tiny module-level pub/sub for the "currently selected variant"
 * on a product detail page.
 *
 * Why this exists
 *
 *   The PDP renders two interactive surfaces — VariantSelector chips and an
 *   AddToCartButton — that need to agree on which variant the shopper picked.
 *   Astro hydrates each island as its own React tree, so they cannot share a
 *   React context. Instead of bouncing a `CustomEvent` off `document` (which
 *   was the temporary bridge before this module landed), we keep the selected
 *   variant in a module-level singleton with a minimal subscribe/get/set API.
 *
 * Shape
 *
 *   - Keyed by `productId` so two PDP islands on the same page (rare in
 *     practice, but cheap to support) don't trample each other's selection.
 *   - The stored value carries `available` alongside `variantId` because
 *     AddToCartButton needs both — a sold-out chip should still update the
 *     button's disabled state on click.
 *
 * SSR and laziness
 *
 *   No top-level side effects. The internal Map and listener Set are
 *   created at module load and remain empty until the first writer or
 *   subscriber arrives, so importing this file from an SSR-rendered island
 *   does not touch `window`/`document`.
 *
 *   The React adapter `useSelectedVariant` only subscribes inside an effect,
 *   so server rendering yields the seeded fallback value the caller passes.
 */
import { useEffect, useState } from "react";

/** Stored snapshot per product. */
export interface SelectedVariant {
  variantId: string;
  /** Mirrors the chip's `available` flag — false for sold-out variants. */
  available: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const state = new Map<string, SelectedVariant>();

function emit(): void {
  // Snapshot the listener set so a callback that subscribes/unsubscribes
  // synchronously does not perturb iteration.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      // A misbehaving subscriber should not break peers. Keep the surface
      // resilient — the cost of swallowing here is a console log only.
      console.error("[variant-store] subscriber threw:", err);
    }
  }
}

/**
 * Read the currently selected variant for a product. Returns `undefined`
 * when no selection has been made yet (e.g. before the chips island
 * hydrates). The hook below seeds an initial value so callers don't have
 * to special-case the undefined branch.
 */
export function getSelectedVariant(
  productId: string,
): SelectedVariant | undefined {
  return state.get(productId);
}

/**
 * Set the selected variant for a product. Notifies every subscriber once,
 * regardless of how many products are tracked — subscribers filter by
 * productId themselves. Skips the broadcast when the new value is
 * structurally equal to the old one to avoid redundant React re-renders.
 */
export function setSelectedVariant(
  productId: string,
  next: SelectedVariant,
): void {
  const current = state.get(productId);
  if (
    current &&
    current.variantId === next.variantId &&
    current.available === next.available
  ) {
    return;
  }
  state.set(productId, next);
  emit();
}

/**
 * Subscribe to selection changes across all tracked products. The callback
 * fires after every successful `setSelectedVariant` call. Returns an
 * unsubscribe function.
 */
export function subscribeVariant(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React adapter — re-renders the calling component whenever the selection
 * for `productId` changes.
 *
 * @param productId  Stable product id; used to scope the subscription.
 * @param fallback   Initial value used until the user picks a variant.
 *                   Typically the first variant the page rendered.
 */
export function useSelectedVariant(
  productId: string,
  fallback: SelectedVariant,
): SelectedVariant {
  const [snapshot, setSnapshot] = useState<SelectedVariant>(
    () => state.get(productId) ?? fallback,
  );

  useEffect(() => {
    // Sync once on mount in case the store changed between render and effect.
    const initial = state.get(productId);
    if (initial) setSnapshot(initial);

    return subscribeVariant(() => {
      const current = state.get(productId);
      if (current) setSnapshot(current);
    });
  }, [productId]);

  return snapshot;
}

/**
 * Test-only helper — clears all selections. Not exported from the islands
 * barrel; reach in directly from a unit test if you need a clean slate.
 */
export function __resetVariantStoreForTests(): void {
  state.clear();
  listeners.clear();
}
