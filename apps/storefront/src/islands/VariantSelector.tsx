/**
 * VariantSelector — interactive island.
 *
 * Selected state uses the single accent colour (terracotta border + the
 * label shifts to fg). Unselected chips stay in the warm-neutral palette
 * with a hairline border. Disabled (sold-out) chips render with a
 * strikethrough and stay unclickable.
 *
 * The chip labels stay weight 400 even when selected — earlier iterations
 * bolded the active label which jumped 50 weight units and made the chips
 * "thump" as the user clicked through them. The terracotta border alone
 * is enough state signal in the calmer redesign.
 *
 * When a variant is picked, this island writes to the module-level
 * `variant-store` keyed by `productId`. AddToCartButton subscribes to that
 * same store, so the two surfaces stay in sync without sharing a React
 * tree (Astro hydrates each island independently). See
 * `./lib/variant-store.ts` for the full rationale.
 *
 * NOTE: the selected price is rendered by `ProductDetail` (not here), so
 * this island only renders the chips. The price block above the chips
 * remains anchored at the lowest variant price, matching the typical
 * Saturdays NYC behaviour where chips don't reshuffle a "from" price.
 */
import { useEffect, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { setSelectedVariant } from "./lib/variant-store.js";

export type VariantOption = {
  id: string;
  name: string;
  price: Money;
  compareAt?: Money;
  available: boolean;
};

export type VariantSelectorProps = {
  /** Stable product id — keys the shared variant store. */
  productId: string;
  variants: VariantOption[];
  /** BCP 47 locale for currency formatting. */
  locale: string;
  /** Localized heading for the variant list (e.g. "Pilihan"). */
  heading: string;
  /** Localized "previous price" label for the strikethrough price. */
  compareAtLabel: string;
};

export default function VariantSelector({
  productId,
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

  // Seed the store with the initial variant on mount so subscribers (e.g.
  // AddToCartButton) see a value even before the user clicks a chip. We
  // intentionally do this in an effect rather than at render time — keeping
  // module-level writes out of the render path makes the component safe to
  // server-render and avoids surprising re-render loops in subscribers.
  //
  // Initial seed is keyed to the productId only. Re-seeding when the
  // `variants` array reference changes would clobber the user's pick, so
  // we read `initial` via a ref-equivalent local instead of widening deps.
  const initialVariantId = initial.id;
  const initialAvailable = initial.available;
  useEffect(() => {
    setSelectedVariant(productId, {
      variantId: initialVariantId,
      available: initialAvailable,
    });
  }, [productId, initialVariantId, initialAvailable]);

  function onSelect(variant: VariantOption) {
    setSelectedId(variant.id);
    setSelectedVariant(productId, {
      variantId: variant.id,
      available: variant.available,
    });
  }

  // If there is only a single variant, hide the chips entirely — picking
  // among one option is noise.
  const showChips = variants.length > 1;
  if (!showChips) {
    return null;
  }

  return (
    <div>
      <p className="t-overline text-muted">{heading}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {variants.map((v) => {
          const isSelected = v.id === selected.id;
          if (!v.available) {
            return (
              <button
                key={v.id}
                type="button"
                disabled
                className="cursor-not-allowed border border-line px-5 py-2 t-body text-faint line-through"
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
                  ? "border border-accent px-5 py-2 t-body text-fg transition-colors duration-150"
                  : "border border-line px-5 py-2 t-body text-fg transition-colors duration-150 hover:border-line-strong"
              }
            >
              {v.name}
            </button>
          );
        })}
      </div>

      {/* Selected variant's compare-at, if any — sits below the chips. */}
      {selected.compareAt && (
        <p className="mt-4 t-caption text-muted">
          <span aria-label={compareAtLabel}>
            {formatMoney(selected.compareAt, { locale })}
          </span>
        </p>
      )}
    </div>
  );
}
