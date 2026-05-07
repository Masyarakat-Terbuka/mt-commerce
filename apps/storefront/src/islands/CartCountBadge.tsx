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
 */
import { CartProvider, useCart } from "./CartProvider.js";

function CartCountBadgeInner() {
  const { itemCount } = useCart();
  if (itemCount <= 0) return null;
  // The number is for sighted users; the visually-hidden text gives screen
  // readers a full sentence so the badge isn't read as a stray digit.
  const display = itemCount > 99 ? "99+" : String(itemCount);
  return (
    <span
      className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium leading-none text-paper"
      aria-hidden="true"
    >
      {display}
    </span>
  );
}

export default function CartCountBadge() {
  return (
    <CartProvider>
      <CartCountBadgeInner />
    </CartProvider>
  );
}
