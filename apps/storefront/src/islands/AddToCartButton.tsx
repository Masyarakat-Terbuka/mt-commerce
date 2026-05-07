/**
 * AddToCartButton — interactive island wired to the cart SDK.
 *
 * Behavior:
 *
 *   - Click → ensures a guest cart exists, posts the line item, then opens
 *     the cart drawer (via the `mt:cart-open` window event).
 *   - During the in-flight call: the button is disabled, `aria-busy="true"`,
 *     and a small spinner replaces the label. On success the label flashes
 *     "Ditambahkan" / "Added" for ~900ms before reverting.
 *   - Errors render as a calm inline message below the button, with `role="status"`
 *     and `aria-live="polite"` so screen readers hear it without interrupting.
 *
 * Cross-island coordination:
 *
 *   - VariantSelector dispatches `variant-change` with `{ variantId, available }`;
 *     this button keeps its own `activeVariantId` in sync so the user always
 *     adds the chip they last clicked.
 *   - The provider lives inside this island's tree (each island owns its own
 *     CartProvider); cross-island state syncs through the `mt:cart-changed`
 *     window event broadcast by every mutation.
 */
import { useEffect, useState } from "react";
import { CartProvider, useCart } from "./CartProvider.js";

export type AddToCartButtonProps = {
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
  variantId,
  label,
  soldOutLabel,
  addedLabel,
  errorLabel,
  soldOut = false,
}: AddToCartButtonProps) {
  const [activeVariantId, setActiveVariantId] = useState(variantId);
  const [isSoldOut, setIsSoldOut] = useState(soldOut);
  const [pending, setPending] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { addItem, openDrawer } = useCart();

  useEffect(() => {
    function handleVariantChange(event: Event) {
      const detail = (event as CustomEvent<{ variantId: string; available: boolean }>).detail;
      if (!detail) return;
      setActiveVariantId(detail.variantId);
      setIsSoldOut(!detail.available);
    }
    document.addEventListener("variant-change", handleVariantChange);
    return () => document.removeEventListener("variant-change", handleVariantChange);
  }, []);

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
        className="btn-primary w-full"
      >
        {buttonLabel}
      </button>
      {/* Polite live region — read after the action, not during typing flow. */}
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {justAdded ? addedLabel : ""}
      </p>
      {localError && (
        <p
          role="alert"
          className="mt-3 t-caption text-danger"
        >
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
