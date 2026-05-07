/**
 * ProductDetail — client island for the product detail page.
 *
 * Same rationale as `ProductGrid`: the storefront builds statically, so
 * detail pages cannot count on the API being reachable at build time. We
 * render a placeholder; this island fetches the product by slug once it
 * mounts in the browser.
 *
 * Internally it reuses the existing `VariantSelector` and `AddToCartButton`
 * islands — wiring them up after the fetch succeeds so they receive the
 * fresh variant list rather than build-time stale data.
 */
import { useEffect, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient, type Product as SdkProduct } from "@mt-commerce/sdk";
import VariantSelector, { type VariantOption } from "./VariantSelector";
import AddToCartButton from "./AddToCartButton";

export type ProductDetailProps = {
  apiUrl: string;
  slug: string;
  locale: string;
  loadingLabel: string;
  errorLabel: string;
  notFoundLabel: string;
  variantsHeading: string;
  compareAtLabel: string;
  addToCartLabel: string;
  outOfStockLabel: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; product: SdkProduct }
  | { status: "not_found" }
  | { status: "error" };

function placeholderImage(title: string): string {
  return `https://placehold.co/800x800/png?text=${encodeURIComponent(title.slice(0, 24))}`;
}

function lowestPrice(p: SdkProduct): Money | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

export default function ProductDetail(props: ProductDetailProps) {
  const {
    apiUrl,
    slug,
    locale,
    loadingLabel,
    errorLabel,
    notFoundLabel,
    variantsHeading,
    compareAtLabel,
    addToCartLabel,
    outOfStockLabel,
  } = props;

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: apiUrl });

    async function load() {
      try {
        const product = await client.storefront.products.bySlug(slug, {
          signal: controller.signal,
        });
        setState({ status: "ready", product });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        const code = (err as { code?: string } | null)?.code;
        if (code === "request_aborted") return;
        if (code === "not_found") {
          setState({ status: "not_found" });
          return;
        }
        console.error(`[storefront] ProductDetail(${slug}) fetch failed:`, err);
        setState({ status: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, [apiUrl, slug]);

  if (state.status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600"
      >
        {loadingLabel}
      </p>
    );
  }

  if (state.status === "not_found") {
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600">
        {notFoundLabel}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="rounded border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700"
      >
        {errorLabel}
      </p>
    );
  }

  const { product } = state;
  const description = product.description ?? "";
  const variantOptions: VariantOption[] = product.variants.map((v) => ({
    id: v.id,
    name: v.title ?? v.sku,
    price: v.price,
    ...(v.compareAtPrice ? { compareAt: v.compareAtPrice } : {}),
    available: true,
  }));
  const firstVariant = variantOptions[0];
  const base = lowestPrice(product);

  return (
    <article className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100">
        <img
          src={placeholderImage(product.title)}
          alt={product.title}
          loading="eager"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </div>

      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-neutral-900 md:text-3xl">
            {product.title}
          </h1>
          {description && (
            <p className="mt-2 text-sm text-neutral-600 md:text-base">
              {description}
            </p>
          )}
          {base && (
            <p className="mt-3 text-xl font-semibold text-neutral-900">
              {formatMoney(base, { locale })}
            </p>
          )}
        </header>

        {firstVariant && (
          <>
            <VariantSelector
              variants={variantOptions}
              locale={locale}
              heading={variantsHeading}
              compareAtLabel={compareAtLabel}
            />

            <AddToCartButton
              variantId={firstVariant.id}
              label={addToCartLabel}
              soldOutLabel={outOfStockLabel}
              soldOut={!firstVariant.available}
            />
          </>
        )}
      </div>
    </article>
  );
}
