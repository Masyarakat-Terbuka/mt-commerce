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
import { buildShippingAdminFulfillmentRoutes } from "./routes/admin-fulfillments.js";
import { buildShippingStorefrontRoutes } from "./routes/storefront.js";
import { shippingService } from "./service.js";

export type {
  CancelFulfillmentInput,
  CreateShippingMethodInput,
  Fulfillment,
  FulfillmentActorKind,
  FulfillmentStatus,
  ListFulfillmentsQuery,
  ListShippingMethodsQuery,
  MarkFulfillmentDeliveredInput,
  MarkFulfillmentShippedInput,
  QuoteShippingInput,
  SetFulfillmentTrackingInput,
  ShippingMethod,
  ShippingProviderKind,
  UpdateShippingMethodInput,
} from "./types.js";

export type {
  CancelFulfillmentOptions,
  CreateFulfillmentForOrderInput,
  FulfillmentTransitionOptions,
  MarkFulfillmentShippedOptions,
  SetFulfillmentTrackingOptions,
  ShippingService,
} from "./service.js";
export { ShippingServiceImpl } from "./service.js";
export type { ShippingProvider } from "./providers/types.js";

export {
  ALL_FULFILLMENT_STATUSES,
  canTransition as canTransitionFulfillment,
  isTerminal as isTerminalFulfillment,
  transitionsFor as fulfillmentTransitionsFor,
} from "./state.js";

export { events as fulfillmentEvents } from "./events.js";
export type {
  EventName as FulfillmentEventName,
  EventPayload as FulfillmentEventPayload,
  FulfillmentEventMap,
} from "./events.js";

export { shippingService };
export {
  buildShippingAdminRoutes,
  buildShippingAdminFulfillmentRoutes,
  buildShippingStorefrontRoutes,
};

export const adminRoutes = buildShippingAdminRoutes(shippingService);
export const storefrontRoutes = buildShippingStorefrontRoutes(shippingService);
/**
 * Fulfillment admin routes are built at the route registrar
 * (`apps/api/src/routes/index.ts`) rather than here so the shipping
 * module does not import the orders module — that would create a
 * circular dependency, since the orders service injects the shipping
 * service for the create-on-paid hook. The registrar passes both
 * singletons to the builder when mounting under `/admin/v1`.
 */
