/**
 * QuickAddButton — small "+" overlay on `ProductCard` for single-variant
 * products. Click adds the product to the cart without leaving the listing.
 *
 * Why only single-variant?
 *
 *   Multi-variant products need a colour/size choice. We could pop a
 *   variant picker over the card, but a popover on a hover-revealed
 *   button is brittle on touch (the popover would obscure the card the
 *   user is trying to read) and adds two new states (hover-the-card,
 *   open-the-popover) without a clear win over "tap the card → choose
 *   on the PDP". For now: the + button only renders for products with
 *   exactly one variant; multi-variant products keep their plain-link
 *   behaviour.
 *
 * Hydration cost:
 *
 *   The island is `client:visible`, so cards offscreen never hydrate.
 *   Hydrated cards run a small effect that returns `null` for
 *   multi-variant products, so the only React work for those is a
 *   one-time mount + unmount of an empty fragment. Single-variant cards
 *   render the button shell. The shared cart helper (`addLineItem`)
 *   imports the SDK lazily through Vite's normal ES-module graph; this
 *   is the same SDK already loaded by other cart islands (header badge,
 *   drawer), so the marginal bytes per quick-add card are tiny.
 *
 * Nested-button-inside-anchor:
 *
 *   `ProductCard.astro` wraps the entire card in an `<a>`. The HTML
 *   spec disallows nesting interactive content inside `<a>` for some
 *   pairings, but `<button>` inside `<a>` is widely supported and
 *   render-stable in modern browsers. We make the keyboard / pointer
 *   semantics correct by stopping propagation on the button click —
 *   the `<a>` never sees the synthetic event, so the page does not
 *   navigate to the PDP.
 */
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { addLineItem, openCartDrawer } from "../lib/cart-actions.js";
import { resolveApiUrl } from "../lib/api.js";

export type QuickAddButtonProps = {
  /**
   * Variant id to add when the + button is pressed. The card-level
   * decision of "is this a single-variant product?" already happened
   * server-side; the parent only passes a variant id when there is
   * exactly one to choose. If `null`, the button does not render.
   */
  variantId: string | null;
  /**
   * Number of variants on the product. Renders nothing when not equal
   * to 1 — multi-variant products keep their plain-link card; products
   * with zero variants (an admin edge case) also render nothing rather
   * than risk a confusing add-to-cart on an unconfigured product.
   */
  variantCount: number;
  /** "Tambah ke keranjang" / "Add to cart" — also used as `aria-label`. */
  label: string;
  /** "Ditambahkan" / "Added" — sr-only announcement after a successful add. */
  successLabel: string;
  /** "Gagal menambahkan. Coba lagi." / "Failed to add. Try again." */
  errorLabel: string;
};

/** Successful-add icon flash duration. Matches `AddToCartButton`. */
const SUCCESS_FLASH_MS = 900;
/** Error-message linger; long enough to read, short enough to re-try. */
const ERROR_LINGER_MS = 3500;

export default function QuickAddButton({
  variantId,
  variantCount,
  label,
  successLabel,
  errorLabel,
}: QuickAddButtonProps) {
  // No hydration gate is needed: Astro's `client:visible` renders an
  // empty `<astro-island>` host on the server and only mounts this
  // React component on the client when the card scrolls into view.
  // The first React render IS the only render the visitor sees, so a
  // dedicated `setHydrated(true)` effect (which would trigger the
  // `react-hooks/set-state-in-effect` warning) is unnecessary.
  const [pending, setPending] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [errorVisible, setErrorVisible] = useState(false);

  // Auto-clear the success flash. ~900ms is long enough to perceive but
  // short enough that a double-tap doesn't queue a stale icon swap.
  useEffect(() => {
    if (!justAdded) return;
    const timer = window.setTimeout(
      () => setJustAdded(false),
      SUCCESS_FLASH_MS,
    );
    return () => window.clearTimeout(timer);
  }, [justAdded]);

  // Auto-clear inline error after a few seconds; otherwise it lingers
  // forever on a card the visitor scrolls past.
  useEffect(() => {
    if (!errorVisible) return;
    const timer = window.setTimeout(
      () => setErrorVisible(false),
      ERROR_LINGER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [errorVisible]);

  // Skip the button entirely for products that are not single-variant.
  // Multi-variant products keep their plain-link card behavior;
  // zero-variant products (admin edge case) do too.
  if (variantCount !== 1 || variantId === null) return null;

  async function onClick(event: React.MouseEvent<HTMLButtonElement>) {
    // Prevent the parent `<a>`'s click from navigating to the PDP. We
    // also `preventDefault` belt-and-suspenders: some browsers fire a
    // synthetic anchor activation on Space when an inner control hands
    // focus back via `relatedTarget`, even though the button has its
    // own click handler.
    event.preventDefault();
    event.stopPropagation();
    if (pending || variantId === null) return;
    setPending(true);
    setErrorVisible(false);
    try {
      await addLineItem({
        apiUrl: resolveApiUrl(),
        cartId: null,
        variantId,
        quantity: 1,
      });
      setJustAdded(true);
      openCartDrawer();
    } catch {
      setErrorVisible(true);
    } finally {
      setPending(false);
    }
  }

  // Button class composition:
  //   - Position: top-right of the parent image container (the parent
  //     `<div>` in ProductCard.astro is `relative`).
  //   - Visibility: hidden on desktop until the parent `.group:hover`
  //     reveals it; always visible on mobile (`md:` prefix flips behavior).
  //   - State: hover/active darken to `bg-fg`/`text-paper`.
  //   - Disabled-while-pending lowers opacity and locks pointer events.
  // Transition is scoped to opacity + background-color (no `transition: all`),
  // and `motion-reduce:` skips the fade for users who opted out.
  const baseClasses = [
    "absolute right-2.5 top-2.5 z-10",
    "flex h-8 w-8 items-center justify-center rounded-full",
    "border border-line bg-paper text-fg",
    "hover:bg-fg hover:text-paper active:bg-fg active:text-paper",
    "transition-[opacity,background-color,color] duration-150 motion-reduce:transition-none",
    // Mobile always visible; desktop fades in on card hover. We also
    // reveal on focus-within so keyboard users see the button when
    // they tab onto it (Tailwind v4: `group-focus-visible` works
    // because the parent anchor carries `group`).
    "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100",
    pending ? "pointer-events-none opacity-50" : "",
  ].join(" ");

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-busy={pending}
        disabled={pending}
        className={baseClasses}
      >
        {pending ? (
          // Tiny inline spinner — matches `AddToCartButton`'s "…" pattern
          // visually (a still-grey indicator) without occupying the same
          // vertical space the icon needs. Using a CSS-only ring keeps
          // bundle size flat (no extra icon import for the spinner).
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
          />
        ) : justAdded ? (
          <HugeiconsIcon
            icon={Tick02Icon}
            size={16}
            strokeWidth={1.75}
            aria-hidden
          />
        ) : (
          <HugeiconsIcon
            icon={Add01Icon}
            size={16}
            strokeWidth={1.75}
            aria-hidden
          />
        )}
      </button>
      {/* Polite live region — sr-only. Announces the success word after
          the icon swap so screen readers hear something concrete.
          Not visible visually; the icon swap carries the visual change. */}
      <p role="status" aria-live="polite" className="sr-only">
        {justAdded ? successLabel : ""}
      </p>
      {errorVisible && (
        // Error toast pinned to the bottom of the image container so it
        // does not push the title and price out of alignment. Calm
        // copy, no exclamation marks.
        <p
          role="alert"
          className="t-caption bg-paper text-danger border-line absolute right-2 bottom-2 left-2 z-10 border px-3 py-2"
        >
          {errorLabel}
        </p>
      )}
    </>
  );
}
