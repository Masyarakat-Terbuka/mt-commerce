/**
 * Module-level wire convenience.
 *
 * Re-exports the route builders so callers wiring the top-level router
 * can import everything they need from the public module entry point.
 * Mirrors the same split used by the cart and checkout modules.
 */
import { buildTaxAdminRoutes } from "./routes/admin.js";
import { buildTaxStorefrontRoutes } from "./routes/storefront.js";

export { buildTaxAdminRoutes, buildTaxStorefrontRoutes };
