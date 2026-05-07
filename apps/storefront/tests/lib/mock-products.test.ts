import { describe, it, expect } from "vitest";
import { MOCK_PRODUCTS, MOCK_CATEGORIES } from "../../src/lib/mock-products.ts";

describe("mock products", () => {
  it("has at least six products", () => {
    expect(MOCK_PRODUCTS.length).toBeGreaterThanOrEqual(6);
  });

  it("each product has required fields and at least one variant", () => {
    for (const p of MOCK_PRODUCTS) {
      expect(p.id).toMatch(/^prod_/);
      expect(p.slug).toBeTruthy();
      expect(p.title.id).toBeTruthy();
      expect(p.title.en).toBeTruthy();
      expect(p.description.id).toBeTruthy();
      expect(p.description.en).toBeTruthy();
      expect(p.imageUrl).toMatch(/^https?:\/\//);
      expect(p.variants.length).toBeGreaterThanOrEqual(1);
      expect(p.basePrice.currency).toBe("IDR");
      expect(typeof p.basePrice.amount).toBe("bigint");
      expect(p.basePrice.amount).toBeGreaterThan(0n);
    }
  });

  it("each product variant has IDR price as bigint", () => {
    for (const p of MOCK_PRODUCTS) {
      for (const v of p.variants) {
        expect(v.price.currency).toBe("IDR");
        expect(typeof v.price.amount).toBe("bigint");
        expect(v.price.amount).toBeGreaterThan(0n);
      }
    }
  });

  it("each product references an existing category", () => {
    const slugs = new Set(MOCK_CATEGORIES.map((c) => c.slug));
    for (const p of MOCK_PRODUCTS) {
      expect(slugs.has(p.categorySlug)).toBe(true);
    }
  });

  it("product slugs are unique", () => {
    const slugs = MOCK_PRODUCTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
