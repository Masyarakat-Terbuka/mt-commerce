# Catalog module

Owns products, variants, categories, and inventory. First "real" product
module on the platform — per ADR-0005, no other module reaches into the
tables here directly. Cross-module callers go through `catalogService`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table                  | Purpose                                         | ID prefix |
| ---------------------- | ----------------------------------------------- | --------- |
| `categories`           | Tree of categories (self-referencing `parent_id`) | `cat_`  |
| `products`             | Product header (status, default currency, slug)   | `prod_` |
| `product_variants`     | Priced SKU under a product                        | `var_`  |
| `inventory_levels`     | Per-variant, per-location stock                   | `inv_`  |
| `product_categories`   | M:N junction between products and categories      | —       |

Money fields follow ADR-0007: `bigint` amount + ISO 4217 currency code,
mapped to a `Money` value object at the service boundary.

## Service interface

```ts
import { catalogService, type CatalogService } from "./modules/catalog";
```

```ts
interface CatalogService {
  // Products
  createProduct(input): Promise<Product>;
  getProductById(id): Promise<Product | null>;
  getProductBySlug(slug, { activeOnly? }): Promise<Product | null>;
  listProducts(query & { activeOnly? }): Promise<Paginated<Product>>;
  updateProduct(id, patch): Promise<Product>;
  softDeleteProduct(id): Promise<void>;

  // Variants
  createVariant(productId, input): Promise<Variant>;
  updateVariant(id, patch): Promise<Variant>;
  softDeleteVariant(id): Promise<void>;

  // Categories
  listCategories(): Promise<Category[]>;
  createCategory(input): Promise<Category>;
  updateCategory(id, patch): Promise<Category>;
  deleteCategory(id): Promise<void>; // hard delete

  // Inventory
  getInventory(variantId): Promise<InventoryLevel | null>;
  adjustInventory(variantId, delta): Promise<InventoryLevel>;
}
```

`Product`, `Variant`, etc. are domain types. Money is a `Money` value object,
dates are `Date` instances. The HTTP layer (in `routes/wire.ts`) converts both
to JSON-safe strings on the way out.

## HTTP routes

### Admin (mounted at `/admin/v1`)

| Method  | Path                                            | Notes                                     |
| ------- | ----------------------------------------------- | ----------------------------------------- |
| GET     | `/admin/v1/products`                            | List with pagination/filters               |
| POST    | `/admin/v1/products`                            | Create                                     |
| GET     | `/admin/v1/products/:id`                        | By id                                      |
| PATCH   | `/admin/v1/products/:id`                        | Update                                     |
| DELETE  | `/admin/v1/products/:id`                        | Soft delete                                |
| POST    | `/admin/v1/products/:id/variants`               | Create variant                             |
| PATCH   | `/admin/v1/variants/:id`                        | Update                                     |
| DELETE  | `/admin/v1/variants/:id`                        | Soft delete                                |
| GET     | `/admin/v1/categories`                          | List                                       |
| POST    | `/admin/v1/categories`                          | Create                                     |
| PATCH   | `/admin/v1/categories/:id`                      | Update                                     |
| DELETE  | `/admin/v1/categories/:id`                      | Hard delete                                |
| POST    | `/admin/v1/variants/:id/inventory/adjust`       | Body `{ delta: number }`                   |

### Storefront (mounted at `/storefront/v1`)

| Method  | Path                                | Notes                                                |
| ------- | ----------------------------------- | ---------------------------------------------------- |
| GET     | `/storefront/v1/products`           | Active only; pagination, filters (`categorySlug`, search, price range), sort |
| GET     | `/storefront/v1/products/:slug`     | Active only; includes variants                        |
| GET     | `/storefront/v1/categories`         | Flat list with `parent_id`; client builds the tree    |

## Pagination

Offset-based for v0.1.

```json
{
  "data": [...],
  "total": 117,
  "page": 1,
  "pageSize": 20
}
```

- Default `pageSize: 20`, max `100`
- `page` is 1-indexed
- Cursor-based pagination is a follow-up if/when the storefront list grows
  past the point where deep offsets matter

## Currency rule

A variant's `priceCurrency` must equal the parent product's
`defaultCurrency`. If `priceCurrency` is omitted on variant creation, the
product default is used. Cross-currency variants under one product are
forbidden — create separate products for separate currencies.

## TODO follow-ups

- `requireRole('admin')` middleware once the auth module ships
- `audit_log` integration for `adjustInventory` (and product/variant edits)
- Image upload (separate concern; local disk first)
- Integration tests against a real Postgres
- OpenAPI annotations via `@hono/zod-openapi` for both admin and storefront
- Price-based sort for `listProducts` (currently degrades to "newest")
- Multi-location inventory (the `location_id` column is in place;
  the service writes NULL today)
