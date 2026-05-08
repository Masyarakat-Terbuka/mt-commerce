/**
 * Unit tests for the request-time adapters in `lib/api.ts`.
 *
 * `toProductCard`, `toProductCardListing`, and `toInitialProduct` are the
 * boundary that lets pages seed `<ProductGrid />` and `<ProductDetail />`
 * with request-time data. They run on every product page render, so the
 * shape they emit needs to stay stable.
 */
import { describe, expect, it } from "vitest";
import { MOCK_PRODUCTS } from "../../src/lib/mock-products.ts";
import {
  toInitialProduct,
  toProductCard,
  toProductCardListing,
  type ListProductsResult,
  type StoreProduct,
} from "../../src/lib/api.ts";

// The mock-products fixture matches the storefront's `StoreProduct` shape
// closely enough that we can hand it to the adapters directly. We adapt
// the few fields the fixture doesn't carry (`hasImage`, `imageAlt`) so
// the adapter's input precondition holds.
function asStoreProduct(p: (typeof MOCK_PRODUCTS)[number]): StoreProduct {
  return {
    ...p,
    hasImage: true,
    imageAlt: { id: p.title.id, en: p.title.en },
  };
}

describe("toProductCard", () => {
  it("resolves the locale-bound title to a single string", () => {
    const sample = asStoreProduct(MOCK_PRODUCTS[0]!);
    const cardId = toProductCard(sample, "id");
    const cardEn = toProductCard(sample, "en");
    expect(cardId.title).toBe(sample.title.id);
    expect(cardEn.title).toBe(sample.title.en);
  });

  it("forwards image fields and clears imageUrl when hasImage is false", () => {
    const sample: StoreProduct = {
      ...asStoreProduct(MOCK_PRODUCTS[0]!),
      hasImage: false,
    };
    const card = toProductCard(sample, "id");
    expect(card.imageUrl).toBeNull();
  });

  it("preserves variant prices and compareAt as Money shapes", () => {
    const sample = asStoreProduct(MOCK_PRODUCTS[0]!);
    const card = toProductCard(sample, "id");
    expect(card.variants.length).toBe(sample.variants.length);
    for (let i = 0; i < card.variants.length; i++) {
      const cv = card.variants[i]!;
      const sv = sample.variants[i]!;
      expect(cv.price).toEqual(sv.price);
      expect(cv.compareAtPrice ?? null).toEqual(sv.compareAt ?? null);
    }
  });
});

describe("toProductCardListing", () => {
  it("preserves pagination metadata", () => {
    const result: ListProductsResult = {
      items: MOCK_PRODUCTS.slice(0, 2).map(asStoreProduct),
      total: 17,
      page: 2,
      pageSize: 9,
      totalPages: 2,
    };
    const listing = toProductCardListing(result, "id");
    expect(listing.total).toBe(17);
    expect(listing.page).toBe(2);
    expect(listing.pageSize).toBe(9);
    expect(listing.totalPages).toBe(2);
    expect(listing.items.length).toBe(2);
  });
});

describe("toInitialProduct", () => {
  it("resolves description to the active locale and exposes categoryIds", () => {
    const sample = asStoreProduct(MOCK_PRODUCTS[0]!);
    const initial = toInitialProduct(sample, "en");
    expect(initial.description).toBe(sample.description.en);
    expect(initial.categoryIds).toEqual([sample.categorySlug]);
  });

  it("falls back to variant id when sku is unavailable on StoreProduct", () => {
    const sample = asStoreProduct(MOCK_PRODUCTS[0]!);
    const initial = toInitialProduct(sample, "id");
    expect(initial.variants.length).toBe(sample.variants.length);
    for (let i = 0; i < initial.variants.length; i++) {
      const iv = initial.variants[i]!;
      const sv = sample.variants[i]!;
      expect(iv.sku).toBe(sv.id);
      expect(iv.id).toBe(sv.id);
      expect(iv.price).toEqual(sv.price);
    }
  });
});
