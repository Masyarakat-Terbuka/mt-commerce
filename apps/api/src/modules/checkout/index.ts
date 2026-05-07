/**
 * Checkout module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `Checkout`, `CheckoutState`, `CheckoutEvent`,
 *     `OrderIntent` and the input shapes used to drive transitions.
 *   - The `CheckoutService` interface and a default `checkoutService`
 *     singleton wired to the runtime database.
 *   - State-machine helpers (`canTransition`, `transitionsFor`,
 *     `isTerminal`, `ALL_CHECKOUT_STATES`) — pure, no I/O.
 *   - Route builders (`buildCheckoutAdminRoutes`,
 *     `buildCheckoutStorefrontRoutes`) plus pre-built singletons.
 *   - The typed event bus (`events`) and the event payload map. Future
 *     modules emit/listen via this bus; ARCHITECTURE.md "Background jobs
 *     and events" describes the trade-off vs. BullMQ for critical work.
 */
import { buildCheckoutAdminRoutes } from "./routes/admin.js";
import { buildCheckoutStorefrontRoutes } from "./routes/storefront.js";
import { checkoutService } from "./service.js";

export type {
  CancelCheckoutInput,
  Checkout,
  CheckoutEvent,
  CheckoutState,
  CompleteCheckoutInput,
  ListCheckoutsQuery,
  OrderIntent,
  OrderIntentAddress,
  OrderIntentLine,
  OrderIntentTotals,
  Paginated,
  SetAddressesInput,
  SetShippingInput,
  StartCheckoutInput,
} from "./types.js";

export type { CheckoutService, CompleteCheckoutResult } from "./service.js";
export { CheckoutServiceImpl } from "./service.js";

export {
  ALL_CHECKOUT_STATES,
  canTransition,
  isTerminal,
  transitionsFor,
} from "./state.js";

export { events } from "./events.js";
export type { CheckoutEventMap, EventName, EventPayload } from "./events.js";

export { checkoutService };
export { buildCheckoutAdminRoutes, buildCheckoutStorefrontRoutes };

export const adminRoutes = buildCheckoutAdminRoutes(checkoutService);
export const storefrontRoutes = buildCheckoutStorefrontRoutes(checkoutService);
