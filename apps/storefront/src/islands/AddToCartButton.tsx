/**
 * AddToCartButton — interactive island.
 *
 * The Astro page passes the initial variant. `VariantSelector` (also an island)
 * may emit a `variant-change` CustomEvent on the document; this button picks
 * that up so the two islands stay in sync without a global store. When the
 * cart module lands this lifts to a shared client-side store (probably
 * `nanostores` or similar).
 *
 * `onAdd` is a placeholder that just logs. The real implementation will call
 * the SDK (see ADR-0008).
 */
import { useEffect, useState } from "react";

export type AddToCartButtonProps = {
  variantId: string;
  label: string;
  soldOutLabel: string;
  soldOut?: boolean;
};

export default function AddToCartButton({
  variantId,
  label,
  soldOutLabel,
  soldOut = false,
}: AddToCartButtonProps) {
  const [activeVariantId, setActiveVariantId] = useState(variantId);
  const [isSoldOut, setIsSoldOut] = useState(soldOut);

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

  function onAdd() {
    if (isSoldOut) return;
    // Placeholder. Real implementation calls SDK and updates cart store.
    console.log("[storefront] add to cart:", activeVariantId);
  }

  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={isSoldOut}
      className={
        isSoldOut
          ? "w-full cursor-not-allowed rounded bg-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-500"
          : "w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800"
      }
    >
      {isSoldOut ? soldOutLabel : label}
    </button>
  );
}
