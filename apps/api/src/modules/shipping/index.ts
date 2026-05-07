/**
 * Shipping module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `ShippingMethod`, `Fulfillment`, `ShippingProviderKind`,
 *     `FulfillmentStatus`, plus the input shapes used to mutate methods.
 *   - The `ShippingService` interface and a default `shippingService`
 *     singleton wired to the runtime database + manual provider.
 *   - The `ShippingProvider` interface — re-exported so plugin authors
 *     have a stable contract to implement.
 *   - Route builders (`buildShippingAdminRoutes`,
 *     `buildShippingStorefrontRoutes`) plus pre-built singletons.
 */
import { buildShippingAdminRoutes } from "./routes/admin.js";
import { buildShippingStorefrontRoutes } from "./routes/storefront.js";
import { shippingService } from "./service.js";

export type {
  CreateShippingMethodInput,
  Fulfillment,
  FulfillmentStatus,
  ListShippingMethodsQuery,
  QuoteShippingInput,
  ShippingMethod,
  ShippingProviderKind,
  UpdateShippingMethodInput,
} from "./types.js";

export type { ShippingService } from "./service.js";
export { ShippingServiceImpl } from "./service.js";
export type { ShippingProvider } from "./providers/types.js";

export { shippingService };
export { buildShippingAdminRoutes, buildShippingStorefrontRoutes };

export const adminRoutes = buildShippingAdminRoutes(shippingService);
export const storefrontRoutes = buildShippingStorefrontRoutes(shippingService);
