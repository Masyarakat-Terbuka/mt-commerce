/**
 * Module-level wire convenience.
 *
 * Re-exports the route builders so callers wiring the top-level router
 * can import everything they need from the public module entry point.
 * Mirrors the orders/checkout module shape.
 */
import { buildPaymentsAdminRoutes } from "./routes/admin.js";
import { buildPaymentsStorefrontRoutes } from "./routes/storefront.js";
import { buildPaymentsWebhookRoutes } from "./routes/webhook.js";

export {
  buildPaymentsAdminRoutes,
  buildPaymentsStorefrontRoutes,
  buildPaymentsWebhookRoutes,
};
