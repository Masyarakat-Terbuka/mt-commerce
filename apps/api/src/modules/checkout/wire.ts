/**
 * Module-level wire convenience.
 *
 * Re-exports the route builders so callers wiring the top-level router can
 * import everything they need from the public module entry point. This
 * matches the cart module's `routes/wire.ts` and `index.ts` split.
 */
import { buildCheckoutAdminRoutes } from "./routes/admin.js";
import { buildCheckoutStorefrontRoutes } from "./routes/storefront.js";

export { buildCheckoutAdminRoutes, buildCheckoutStorefrontRoutes };
