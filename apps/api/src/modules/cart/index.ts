/**
 * Cart module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `Cart`, `CartItem`, `CartTotals`, `CartStatus`,
 *     `Paginated<T>` and the input shapes used to mutate carts.
 *   - The `CartService` interface and a default `cartService` singleton
 *     wired to the runtime database.
 *   - Route builders (`buildCartAdminRoutes`, `buildCartStorefrontRoutes`)
 *     plus pre-built singletons (`adminRoutes`, `storefrontRoutes`).
 */
import { buildCartAdminRoutes } from "./routes/admin.js";
import { buildCartStorefrontRoutes } from "./routes/storefront.js";
import { cartService } from "./service.js";

export type {
  AddItemInput,
  AppliedTaxRate,
  Cart,
  CartItem,
  CartStatus,
  CartTotals,
  CreateCartInput,
  ListCartsQuery,
  Paginated,
  UpdateItemQuantityInput,
} from "./types.js";

export type { CartService, GetTotalsOptions } from "./service.js";
export { CartServiceImpl } from "./service.js";

export { cartService };
export { buildCartAdminRoutes, buildCartStorefrontRoutes };

export const adminRoutes = buildCartAdminRoutes(cartService);
export const storefrontRoutes = buildCartStorefrontRoutes(cartService);
