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
  // Hooks must run on every render in the same order — gate the JSX below,
  // not the hook calls. Initial state defaults to "" when the variant list
  // is empty so React's hook-order invariant holds across renders that flip
  // between empty and non-empty (e.g. an upstream slug change).
  const initial = variants[0];
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const selected = variants.find((v) => v.id === selectedId) ?? initial ?? null;

  // Seed the store with the initial variant on mount so subscribers (e.g.
  // AddToCartButton) see a value even before the user clicks a chip. We
  // intentionally do this in an effect rather than at render time — keeping
  // module-level writes out of the render path makes the component safe to
  // server-render and avoids surprising re-render loops in subscribers.
  //
  // Initial seed is keyed to the productId only. Re-seeding when the
  // `variants` array reference changes would clobber the user's pick, so
  // we read `initial` via a ref-equivalent local instead of widening deps.
  const initialVariantId = initial?.id ?? null;
  const initialAvailable = initial?.available ?? false;
  useEffect(() => {
    if (initialVariantId === null) return;
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

  // Render gates run after every hook so the order stays stable: skip the
  // chips when there are zero variants (nothing to render) or only one
  // (picking among one option is noise).
  if (!selected || variants.length <= 1) {
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
                className="border-line t-body text-faint cursor-not-allowed border px-5 py-2 line-through"
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
                  ? "border-accent t-body text-fg border px-5 py-2 transition-colors duration-150"
                  : "border-line t-body text-fg hover:border-line-strong border px-5 py-2 transition-colors duration-150"
              }
            >
              {v.name}
            </button>
          );
        })}
      </div>

      {/* Selected variant's compare-at, if any — sits below the chips. */}
      {selected.compareAt && (
        <p className="t-caption text-muted mt-4">
          <span aria-label={compareAtLabel}>
            {formatMoney(selected.compareAt, { locale })}
          </span>
        </p>
      )}
    </div>
  );
}
