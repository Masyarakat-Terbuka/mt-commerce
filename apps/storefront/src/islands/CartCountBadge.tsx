/**
 * CartCountBadge — tiny header island that mirrors `useCart().itemCount`.
 *
 * Renders nothing when the count is zero — the bag icon already lives in the
 * Header.astro markup, and an empty zero-badge would be a fixed visual
 * footnote shoppers don't need to read.
 *
 * Sits inside its own CartProvider so the header can hydrate this badge
 * without the rest of the page being a React subtree (Astro's island model).
 * Cross-island sync flows through the `mt:cart-changed` window event the
 * provider listens to.
 *
 * Visual feedback on add (priority-1 polish):
 *
 *   - When the broadcast event reports a positive `delta`, we toggle a
 *     `data-cart-bump="1"` attribute for ~240 ms. The CSS rule in
 *     `global.css` plays a transform-only scale pulse (1 → 1.25 → 1) on
 *     the badge so a successful add is visible at a glance.
 *   - `prefers-reduced-motion: reduce` is honored in the same stylesheet —
 *     the bump degrades to a single-frame colour flash rather than a
 *     transform pulse. No JS branching needed here.
 *   - A polite `aria-live` region announces the new count alongside the
 *     visible badge so screen readers also hear the update.
 */
import { useEffect, useRef, useState } from "react";
import {
  CART_CHANGED_EVENT_NAME,
  CartProvider,
  useCart,
  type CartChangedDetail,
} from "./CartProvider.js";

export interface CartCountBadgeProps {
  /**
   * Localized template for the screen-reader announcement, with `{count}`
   * placeholder. e.g. "Keranjang: {count}". Required for accessible
   * status updates per the Web Interface Guidelines (async updates need
   * `aria-live="polite"`).
   */
  announceTemplate: string;
}

function CartCountBadgeInner({ announceTemplate }: CartCountBadgeProps) {
  const { itemCount } = useCart();
  // `bump` is the ephemeral data-attribute the CSS keys off; we wipe it
  // after one animation cycle so a follow-up add re-triggers cleanly.
  const [bump, setBump] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent<CartChangedDetail>).detail;
      // Defensive — older dispatch sites may emit the event without detail.
      if (!detail || typeof detail.delta !== "number") return;
      // Only bump on a positive delta. Removes/clears must not feel
      // celebratory; the count quietly drops.
      if (detail.delta <= 0) return;

      // Toggle the attribute on a fresh tick so the keyframe restarts even
      // if the user double-clicks. Each bump uses a unique timestamp so
      // React reschedules the effect.
      setBump(Date.now());
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setBump(0), 280);
    }
    window.addEventListener(CART_CHANGED_EVENT_NAME, onChange);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT_NAME, onChange);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const announcement =
    itemCount > 0 ? announceTemplate.replace("{count}", String(itemCount)) : "";

  if (itemCount <= 0) {
    // Even when the badge isn't visible we keep the live region mounted
    // so a future add still announces. The empty announcement is fine —
    // assistive tech reads the new content the moment it changes.
    return (
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    );
  }

  // The number is for sighted users; the visually-hidden text alongside
  // gives screen readers a full sentence so the badge isn't read as a
  // stray digit.
  const display = itemCount > 99 ? "99+" : String(itemCount);
  return (
    <>
      <span
        // `key` doesn't matter for the CSS animation — the data-cart-bump
        // attribute restart drives it. We do flip the attribute value
        // each time so the browser sees a real change.
        data-cart-bump={bump > 0 ? "1" : "0"}
        className="bg-accent text-paper absolute -top-1 -right-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] leading-none font-medium"
        aria-hidden="true"
      >
        {display}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

export default function CartCountBadge(props: CartCountBadgeProps) {
  return (
    <CartProvider>
      <CartCountBadgeInner {...props} />
    </CartProvider>
  );
}
