/**
 * Orders module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing
 * layer import only what this file re-exports. Anything not surfaced
 * here is an implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `Order`, `OrderItem`, `OrderStatus`, `OrderStatusEvent`,
 *     `OrderAddressSnapshot`, `Paginated<T>`, plus the input shapes used
 *     to drive transitions.
 *   - The `OrderService` interface and a default `orderService` singleton
 *     wired to the runtime database.
 *   - State-machine helpers (`canTransition`, `transitionsFor`,
 *     `isTerminal`, `ALL_ORDER_STATUSES`) — pure, no I/O.
 *   - Route builders (`buildOrdersAdminRoutes`,
 *     `buildOrdersStorefrontRoutes`) plus pre-built singletons.
 *   - The typed event bus (`events`) and the event payload map. Future
 *     modules (notifications) emit/listen via this bus.
 */
import { buildOrdersAdminRoutes } from "./routes/admin.js";
import { buildOrdersStorefrontRoutes } from "./routes/storefront.js";
import { orderService } from "./service.js";

export type {
  CancelOrderInput,
  ListMyOrdersQuery,
  ListOrdersQuery,
  Order,
  OrderActorKind,
  OrderAddressSnapshot,
  OrderItem,
  OrderStatus,
  OrderStatusEvent,
  Paginated,
  TransitionOrderInput,
} from "./types.js";

export type {
  CancelOptions,
  CreateFromIntentOptions,
  OrderService,
  TransitionOptions,
} from "./service.js";
export { OrderServiceImpl } from "./service.js";

export {
  ALL_ORDER_STATUSES,
  canTransition,
  isTerminal,
  timestampColumnFor,
  transitionsFor,
} from "./state.js";

export { events } from "./events.js";
export type { EventName, EventPayload, OrderEventMap } from "./events.js";

export { orderService };
export { buildOrdersAdminRoutes, buildOrdersStorefrontRoutes };

export const adminRoutes = buildOrdersAdminRoutes(orderService);
export const storefrontRoutes = buildOrdersStorefrontRoutes(orderService);
