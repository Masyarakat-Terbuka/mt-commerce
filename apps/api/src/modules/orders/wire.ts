/**
 * Module-level wire convenience.
 *
 * Re-exports the route builders so callers wiring the top-level router
 * can import everything they need from the public module entry point.
 * Mirrors the cart/checkout module shape.
 */
import { buildOrdersAdminRoutes } from "./routes/admin.js";
import { buildOrdersStorefrontRoutes } from "./routes/storefront.js";

export { buildOrdersAdminRoutes, buildOrdersStorefrontRoutes };
