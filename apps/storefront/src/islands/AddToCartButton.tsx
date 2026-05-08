/**
 * AddToCartButton — interactive island wired to the cart SDK.
 *
 * Behavior:
 *
 *   - Click → ensures a guest cart exists, posts the line item, then opens
 *     the cart drawer (via the `mt:cart-open` window event).
 *   - During the in-flight call: the button is disabled, `aria-busy="true"`,
 *     and a small spinner replaces the label. On success the label flashes
 *     "Ditambahkan" / "Added" for ~900ms before reverting, paired with a
 *     checkmark icon so the visual change is unmistakable. The cart-count
 *     badge in the header bumps in sync (CSS, see `global.css`), and the
 *     drawer slides in from the right (it auto-closes after ~3s unless the
 *     user interacts).
 *   - Errors render as a calm inline message below the button, with `role="status"`
 *     and `aria-live="polite"` so screen readers hear it without interrupting.
 *
 * Cross-island coordination:
 *
 *   - VariantSelector writes the active chip into `lib/variant-store`. This
 *     button subscribes to the same store keyed by `productId`, so the user
 *     always adds the chip they last clicked — even though the two islands
 *     do not share a React tree (Astro hydrates each one independently).
 *   - The cart provider lives inside this island's tree (each island owns
 *     its own CartProvider); cross-island cart state syncs through the
 *     `mt:cart-changed` window event the provider broadcasts.
 */
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { CartProvider, useCart } from "./CartProvider.js";
import { useSelectedVariant } from "./lib/variant-store.js";

export type AddToCartButtonProps = {
  /** Stable product id — keys the shared variant store. */
  productId: string;
  /** Initial variant id; used as the seed for the shared store. */
  variantId: string;
  label: string;
  soldOutLabel: string;
  /** Briefly displayed after a successful add — e.g. "Ditambahkan". */
  addedLabel: string;
  /** Generic error toast — e.g. "Tidak bisa menambah ke keranjang.". */
  errorLabel: string;
  soldOut?: boolean;
};

function AddToCartButtonInner({
  productId,
  variantId,
  label,
  soldOutLabel,
  addedLabel,
  errorLabel,
  soldOut = false,
}: AddToCartButtonProps) {
  const selected = useSelectedVariant(productId, {
    variantId,
    available: !soldOut,
  });
  const isSoldOut = !selected.available;
  const activeVariantId = selected.variantId;

  const [pending, setPending] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { addItem, openDrawer } = useCart();

  // Auto-clear the success flash after ~900ms; long enough to be perceived,
  // short enough that double-tapping doesn't queue a stale label.
  useEffect(() => {
    if (!justAdded) return;
    const timer = window.setTimeout(() => setJustAdded(false), 900);
    return () => window.clearTimeout(timer);
  }, [justAdded]);

  async function onAdd() {
    if (isSoldOut || pending) return;
    setPending(true);
    setLocalError(null);
    try {
      await addItem(activeVariantId, 1);
      setJustAdded(true);
      openDrawer();
    } catch {
      // Calm, generic copy — the API error code is internal noise for shoppers.
      setLocalError(errorLabel);
    } finally {
      setPending(false);
    }
  }

  // Three visual states for the button content:
  //   - sold out: static label, no icon.
  //   - pending: lone ellipsis (matches WIG "loading states end with …").
  //   - just added: label + checkmark, weight-400 success-coloured icon.
  //   - default: plain label.
  const buttonLabel = isSoldOut
    ? soldOutLabel
    : pending
      ? "…"
      : justAdded
        ? addedLabel
        : label;

  return (
    <div>
      <button
        type="button"
        onClick={onAdd}
        disabled={isSoldOut || pending}
        aria-busy={pending}
        // The status doubles via aria-label so a screen reader announces
        // the post-click state ("Ditambahkan") on top of the polite live
        // region below — covering both the visible flash and the click
        // feedback.
        aria-label={justAdded ? addedLabel : undefined}
        className="btn-primary w-full"
      >
        {/* The icon is sized to match the label's leading height (~17px)
            and sits to the LEFT of the text so the visual reads "checkmark,
            then the success word". `aria-hidden` because the success word
            already conveys the meaning. The icon is conditionally rendered
            so the layout stays stable when no icon is needed. */}
        {justAdded && (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={17}
            strokeWidth={1.5}
            aria-hidden
            className="mr-2 inline-flex shrink-0"
          />
        )}
        {buttonLabel}
      </button>
      {/* Polite live region — read after the action, not during typing flow. */}
      <p role="status" aria-live="polite" className="sr-only">
        {justAdded ? addedLabel : ""}
      </p>
      {localError && (
        <p role="alert" className="t-caption text-danger mt-3">
          {localError}
        </p>
      )}
    </div>
  );
}

export default function AddToCartButton(props: AddToCartButtonProps) {
  // Each island wraps its own provider — Astro renders islands in separate
  // React trees, so a top-level provider would not reach here. State stays
  // consistent across islands via the `mt:cart-changed` event the provider
  // listens to.
  return (
    <CartProvider>
      <AddToCartButtonInner {...props} />
    </CartProvider>
  );
}
