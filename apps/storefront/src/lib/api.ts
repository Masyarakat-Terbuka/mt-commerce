// Replace with @mt-commerce/sdk once it ships (see ADR-0008).
//
// This module is the single boundary the storefront uses to talk to "the API".
// While the SDK is not yet available, it serves mock data from `mock-products.ts`.
// Pages and components import only from here, so the swap to the real SDK is a
// localized change.

import {
  MOCK_CATEGORIES,
  MOCK_PRODUCTS,
  type Category,
  type Product,
} from "./mock-products.js";

export type SortKey = "newest" | "price_asc" | "price_desc";

export type ListProductsQuery = {
  category?: string;
  search?: string;
  minPrice?: bigint;
  maxPrice?: bigint;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
};

export type ListProductsResult = {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const DEFAULT_PAGE_SIZE = 12;

export function listCategories(): Category[] {
  return MOCK_CATEGORIES;
}

export function getCategoryBySlug(slug: string): Category | undefined {
  return MOCK_CATEGORIES.find((c) => c.slug === slug);
}

export function getProductBySlug(slug: string): Product | undefined {
  return MOCK_PRODUCTS.find((p) => p.slug === slug);
}

export function listProducts(query: ListProductsQuery = {}): ListProductsResult {
  const {
    category,
    search,
    minPrice,
    maxPrice,
    sort = "newest",
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = query;

  let items = [...MOCK_PRODUCTS];

  if (category) {
    items = items.filter((p) => p.categorySlug === category);
  }
  if (search) {
    const needle = search.toLowerCase();
    items = items.filter(
      (p) =>
        p.title.id.toLowerCase().includes(needle) ||
        p.title.en.toLowerCase().includes(needle) ||
        p.description.id.toLowerCase().includes(needle),
    );
  }
  if (typeof minPrice === "bigint") {
    items = items.filter((p) => p.basePrice.amount >= minPrice);
  }
  if (typeof maxPrice === "bigint") {
    items = items.filter((p) => p.basePrice.amount <= maxPrice);
  }

  switch (sort) {
    case "price_asc":
      items.sort((a, b) => Number(a.basePrice.amount - b.basePrice.amount));
      break;
    case "price_desc":
      items.sort((a, b) => Number(b.basePrice.amount - a.basePrice.amount));
      break;
    case "newest":
    default:
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      break;
  }

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return {
    items: paged,
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

export function listFeaturedProducts(limit = 4): Product[] {
  return [...MOCK_PRODUCTS]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}
