/**
 * Drizzle row → domain type mapping. Two interesting collapses are covered
 * here:
 *
 *   1. The price column pair (`price_amount` + `price_currency`) collapses
 *      into a single `Money` value with bigint precision intact.
 *   2. The locale-keyed `translations` JSONB column flattens to plain
 *      `title`/`description`/`name` strings, applying the fallback chain
 *      documented in `i18n.ts` and ADR-0010.
 */
import { describe, expect, it } from "vitest";
import {
  toCategory,
  toInventoryLevel,
  toProduct,
  toVariant,
} from "../../../src/modules/catalog/mappers.js";
import type {
  CategoryRow,
  InventoryLevelRow,
  ProductRow,
  ProductVariantRow,
} from "../../../src/db/schema/index.js";

const fixedDate = new Date("2026-05-07T12:00:00.000Z");

describe("toVariant", () => {
  it("collapses price columns to a Money object with bigint precision", () => {
    const row: ProductVariantRow = {
      id: "var_01",
      productId: "prod_01",
      sku: "SKU-1",
      translations: { id: { title: "Default" } },
      priceAmount: 9_007_199_254_740_993n, // > Number.MAX_SAFE_INTEGER
      priceCurrency: "IDR",
      compareAtAmount: 10_000_000_000n,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    const variant = toVariant(row);
    expect(variant.price.amount).toBe(9_007_199_254_740_993n);
    expect(variant.price.currency).toBe("IDR");
    expect(variant.compareAtPrice?.amount).toBe(10_000_000_000n);
    expect(variant.compareAtPrice?.currency).toBe("IDR");
  });

  it("returns null compareAtPrice when the column is null", () => {
    const row: ProductVariantRow = {
      id: "var_02",
      productId: "prod_02",
      sku: "SKU-2",
      translations: {},
      priceAmount: 100n,
      priceCurrency: "USD",
      compareAtAmount: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    expect(toVariant(row).compareAtPrice).toBeNull();
  });

  it("returns null title for the default-variant case (empty translations)", () => {
    const row: ProductVariantRow = {
      id: "var_03",
      productId: "prod_03",
      sku: "SKU-3",
      translations: {},
      priceAmount: 100n,
      priceCurrency: "IDR",
      compareAtAmount: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    expect(toVariant(row).title).toBeNull();
  });
});

describe("toProduct", () => {
  it("composes variants and category ids into the product domain shape", () => {
    const productRow: ProductRow = {
      id: "prod_x",
      slug: "x",
      translations: { id: { title: "X", description: "D" } },
      status: "active",
      defaultCurrency: "IDR",
      imageUrl: null,
      imageAlt: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    const variantRows: ProductVariantRow[] = [
      {
        id: "var_x1",
        productId: "prod_x",
        sku: "X1",
        translations: {},
        priceAmount: 1n,
        priceCurrency: "IDR",
        compareAtAmount: null,
        createdAt: fixedDate,
        updatedAt: fixedDate,
        deletedAt: null,
      },
    ];
    const product = toProduct(productRow, variantRows, ["cat_a", "cat_b"]);
    expect(product.title).toBe("X");
    expect(product.description).toBe("D");
    expect(product.variants).toHaveLength(1);
    expect(product.categoryIds).toEqual(["cat_a", "cat_b"]);
    expect(product.status).toBe("active");
  });
});

describe("toCategory", () => {
  it("preserves null parentId", () => {
    const row: CategoryRow = {
      id: "cat_root",
      slug: "root",
      translations: { id: { name: "Root" } },
      parentId: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    expect(toCategory(row).parentId).toBeNull();
    expect(toCategory(row).name).toBe("Root");
  });
});

describe("toInventoryLevel", () => {
  it("preserves null locationId for v1 single-location", () => {
    const row: InventoryLevelRow = {
      id: "inv_1",
      variantId: "var_1",
      locationId: null,
      available: 5,
      reserved: 1,
      updatedAt: fixedDate,
    };
    const level = toInventoryLevel(row);
    expect(level.locationId).toBeNull();
    expect(level.available).toBe(5);
    expect(level.reserved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Locale resolution — the core promise of ADR-0010.
// ---------------------------------------------------------------------------

describe("translations locale resolution", () => {
  function buildProductRow(
    translations: ProductRow["translations"],
  ): ProductRow {
    return {
      id: "prod_loc",
      slug: "loc",
      translations,
      status: "active",
      defaultCurrency: "IDR",
      imageUrl: null,
      imageAlt: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
  }

  it("toProductDTO(row, 'en') resolves English when present", () => {
    const row = buildProductRow({
      id: { title: "Kopi Gayo", description: "Kopi arabika dari Aceh." },
      en: { title: "Gayo Coffee", description: "Arabica from Aceh." },
    });
    const product = toProduct(row, [], [], "en");
    expect(product.title).toBe("Gayo Coffee");
    expect(product.description).toBe("Arabica from Aceh.");
  });

  it("toProductDTO(row, 'fr') falls back to default 'id' when locale missing", () => {
    const row = buildProductRow({
      id: { title: "Kopi Gayo", description: "Kopi arabika dari Aceh." },
      en: { title: "Gayo Coffee", description: "Arabica from Aceh." },
    });
    const product = toProduct(row, [], [], "fr");
    expect(product.title).toBe("Kopi Gayo");
    expect(product.description).toBe("Kopi arabika dari Aceh.");
  });

  it("toProductDTO(row, 'en') falls back gracefully when only 'id' is present", () => {
    const row = buildProductRow({
      id: { title: "Kopi Gayo", description: "Kopi arabika dari Aceh." },
    });
    const product = toProduct(row, [], [], "en");
    // Per the resolver's chain: requested → default → first available.
    // Default is `id`, so the en request gets the id strings.
    expect(product.title).toBe("Kopi Gayo");
    expect(product.description).toBe("Kopi arabika dari Aceh.");
  });

  it("description returns null when no locale carries the field", () => {
    const row = buildProductRow({
      id: { title: "Title only" },
    });
    const product = toProduct(row, [], [], "id");
    expect(product.title).toBe("Title only");
    expect(product.description).toBeNull();
  });

  it("toCategoryDTO resolves the requested locale", () => {
    const row: CategoryRow = {
      id: "cat_1",
      slug: "kopi",
      translations: { id: { name: "Kopi" }, en: { name: "Coffee" } },
      parentId: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    expect(toCategory(row, "id").name).toBe("Kopi");
    expect(toCategory(row, "en").name).toBe("Coffee");
    // Unknown locale falls back to default.
    expect(toCategory(row, "fr").name).toBe("Kopi");
  });

  it("toVariantDTO resolves a translated title and falls back across locales", () => {
    const row: ProductVariantRow = {
      id: "var_loc",
      productId: "prod_loc",
      sku: "LOC-1",
      translations: { id: { title: "Bubuk" }, en: { title: "Ground" } },
      priceAmount: 100n,
      priceCurrency: "IDR",
      compareAtAmount: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    expect(toVariant(row, "en").title).toBe("Ground");
    expect(toVariant(row, "id").title).toBe("Bubuk");
    expect(toVariant(row, "fr").title).toBe("Bubuk");
  });
});
