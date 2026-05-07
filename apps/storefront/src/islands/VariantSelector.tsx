/**
 * VariantSelector — interactive island.
 *
 * Selected state uses the single accent color (terracotta border + bold
 * label). Unselected chips stay in the warm-neutral palette. Disabled
 * (sold-out) chips render with a strikethrough and stay unclickable.
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

  // If there is only a single variant, hide the chips entirely — picking
  // among one option is noise. The price still renders below.
  const showChips = variants.length > 1;

  return (
    <div className="space-y-4">
      {showChips && (
        <div>
          <p className="t-caption uppercase tracking-wide text-muted">{heading}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {variants.map((v) => {
              const isSelected = v.id === selected.id;
              if (!v.available) {
                return (
                  <button
                    key={v.id}
                    type="button"
                    disabled
                    className="cursor-not-allowed border border-line px-4 py-2 t-body text-faint line-through"
                  >
                    {v.name}
                  </button>
                );
              }
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onSelect(v)}
                  aria-pressed={isSelected}
                  className={
                    isSelected
                      ? "border border-accent px-4 py-2 t-body font-medium text-fg transition-colors duration-150"
                      : "border border-line px-4 py-2 t-body text-fg transition-colors duration-150 hover:border-line-strong"
                  }
                >
                  {v.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-baseline gap-3">
        <span className="price-figure t-h1 text-fg">
          {formatMoney(selected.price, { locale })}
        </span>
        {selected.compareAt && (
          <span
            className="price-figure t-body text-faint line-through"
            aria-label={compareAtLabel}
          >
            {formatMoney(selected.compareAt, { locale })}
          </span>
        )}
      </div>
    </div>
  );
}
