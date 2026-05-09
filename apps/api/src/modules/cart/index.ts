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
import { customerService } from "../customer/index.js";
import { taxService } from "../tax/index.js";
import { buildCartAdminRoutes } from "./routes/admin.js";
import {
  buildCartStorefrontRoutes,
  type TaxRateResolver,
} from "./routes/storefront.js";
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
export type { TaxRateResolver } from "./routes/storefront.js";
export { CartServiceImpl } from "./service.js";

export { cartService };
export { buildCartAdminRoutes, buildCartStorefrontRoutes };

/**
 * Default tax-rate resolver bound to the live tax service. Per the tax
 * module's contract `getDefaultRate(currency)` returns the configured
 * default rate (or null when none is configured); we map the rate's
 * `(code, rateBasisPoints)` into the shape `getTotals` accepts so the
 * cart module stays unaware of `TaxRate`'s full domain shape (per
 * ADR-0005, modules talk through narrow interfaces).
 */
const defaultTaxRateResolver: TaxRateResolver = async (currency) => {
  const rate = await taxService.getDefaultRate(currency);
  if (!rate) return null;
  return { code: rate.code, rateBasisPoints: rate.rateBasisPoints };
};

export const adminRoutes = buildCartAdminRoutes(
  cartService,
  defaultTaxRateResolver,
);
export const storefrontRoutes = buildCartStorefrontRoutes(
  cartService,
  customerService,
  defaultTaxRateResolver,
);
