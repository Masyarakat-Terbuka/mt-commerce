/**
 * Catalog module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `Product`, `Variant`, `Category`, `InventoryLevel`,
 *     `Paginated<T>` and the input shapes used to mutate them.
 *   - The `CatalogService` interface and a default `catalogService` singleton
 *     wired to the runtime database.
 *   - HTTP routers (`adminRoutes`, `storefrontRoutes`) ready to mount under
 *     their respective prefixes.
 */
import { buildCatalogAdminRoutes } from "./routes/admin.js";
import { buildCatalogStorefrontRoutes } from "./routes/storefront.js";
import { catalogService } from "./service.js";

export type {
  AdjustInventoryInput,
  Category,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  InventoryLevel,
  ListProductsQuery,
  Paginated,
  Product,
  ProductSort,
  ProductStatus,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateVariantInput,
  Variant,
} from "./types.js";

export type { CatalogService } from "./service.js";

export { catalogService };

export const adminRoutes = buildCatalogAdminRoutes(catalogService);
export const storefrontRoutes = buildCatalogStorefrontRoutes(catalogService);
