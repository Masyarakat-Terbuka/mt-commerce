/**
 * VariantSelector — interactive island.
 *
 * When a variant is selected, this island:
 *   1. Updates its own displayed price using local React state.
 *   2. Dispatches a `variant-change` CustomEvent on the document so other
 *      islands on the page (currently `AddToCartButton`) can react.
 *
 * Inter-island communication via DOM events is intentional and minimal. It
 * avoids a global store while the cart module does not yet exist. When that
 * lands, both islands will read from a shared client-side store and this
 * event-bus pattern goes away.
 */
import { useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";

export type VariantOption = {
  id: string;
  name: string;
  price: Money;
  compareAt?: Money;
  available: boolean;
};

export type VariantSelectorProps = {
  variants: VariantOption[];
  /** BCP 47 locale for currency formatting. */
  locale: string;
  /** Localized heading for the variant list (e.g. "Pilihan"). */
  heading: string;
  /** Localized "previous price" label for the strikethrough price. */
  compareAtLabel: string;
};

export default function VariantSelector({
  variants,
  locale,
  heading,
  compareAtLabel,
}: VariantSelectorProps) {
  const initial = variants[0];
  if (!initial) {
    return null;
  }
  const [selectedId, setSelectedId] = useState(initial.id);
  const selected = variants.find((v) => v.id === selectedId) ?? initial;

  function onSelect(variant: VariantOption) {
    setSelectedId(variant.id);
    document.dispatchEvent(
      new CustomEvent("variant-change", {
        detail: { variantId: variant.id, available: variant.available },
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{heading}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {variants.map((v) => {
            const isSelected = v.id === selected.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelect(v)}
                disabled={!v.available}
                aria-pressed={isSelected}
                className={
                  !v.available
                    ? "cursor-not-allowed rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-400 line-through"
                    : isSelected
                      ? "rounded border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white"
                      : "rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
                }
              >
                {v.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="price-figure text-xl font-semibold text-neutral-900">
          {formatMoney(selected.price, { locale })}
        </span>
        {selected.compareAt && (
          <span
            className="price-figure text-sm text-neutral-500 line-through"
            aria-label={compareAtLabel}
          >
            {formatMoney(selected.compareAt, { locale })}
          </span>
        )}
      </div>
    </div>
  );
}
