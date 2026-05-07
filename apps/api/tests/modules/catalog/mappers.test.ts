/**
 * Drizzle row → domain type mapping. The interesting case is the price
 * column pair (`price_amount` + `price_currency`) collapsing into a single
 * `Money` value with bigint precision intact, which is the contract callers
 * outside the module rely on.
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
      title: "Default",
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
      title: null,
      priceAmount: 100n,
      priceCurrency: "USD",
      compareAtAmount: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
      deletedAt: null,
    };
    expect(toVariant(row).compareAtPrice).toBeNull();
  });
});

describe("toProduct", () => {
  it("composes variants and category ids into the product domain shape", () => {
    const productRow: ProductRow = {
      id: "prod_x",
      slug: "x",
      title: "X",
      description: "D",
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
        title: null,
        priceAmount: 1n,
        priceCurrency: "IDR",
        compareAtAmount: null,
        createdAt: fixedDate,
        updatedAt: fixedDate,
        deletedAt: null,
      },
    ];
    const product = toProduct(productRow, variantRows, ["cat_a", "cat_b"]);
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
      name: "Root",
      parentId: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    expect(toCategory(row).parentId).toBeNull();
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
