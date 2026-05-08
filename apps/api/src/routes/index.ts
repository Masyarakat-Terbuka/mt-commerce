/**
 * Top-level route registrar.
 *
 *   /health, /ready              operator-facing, unversioned
 *   /v1/...                      legacy/shared utility routes (e.g. /v1/ping)
 *   /admin/v1/...                admin-facing, versioned API surface
 *   /storefront/v1/...           public storefront-facing, versioned API
 *   /openapi.json, /docs         mounted by `setupOpenApi` in app.ts
 *
 * Per ARCHITECTURE.md, admin and storefront routes mount at their own
 * top-level prefixes rather than nesting under `/v1`. This keeps the audience
 * boundary visible in the URL and lets each side evolve its own version
 * independently.
 *
 * Module routers come from each module's public `index.ts` only — see ADR-0005.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { buildHealthRoutes } from "./health.js";
import { buildV1Routes } from "./v1/index.js";
import { adminRoutes as catalogAdminRoutes, storefrontRoutes as catalogStorefrontRoutes } from "../modules/catalog/index.js";
import { adminRoutes as authAdminRoutes, storefrontRoutes as authStorefrontRoutes } from "../modules/auth/index.js";
import { adminRoutes as customerAdminRoutes, storefrontRoutes as customerStorefrontRoutes } from "../modules/customer/index.js";
import { adminRoutes as cartAdminRoutes, storefrontRoutes as cartStorefrontRoutes } from "../modules/cart/index.js";
import { adminRoutes as checkoutAdminRoutes, storefrontRoutes as checkoutStorefrontRoutes } from "../modules/checkout/index.js";
import { adminRoutes as taxAdminRoutes, storefrontRoutes as taxStorefrontRoutes } from "../modules/tax/index.js";
import {
  adminRoutes as shippingAdminRoutes,
  buildShippingAdminFulfillmentRoutes,
  shippingService,
  storefrontRoutes as shippingStorefrontRoutes,
} from "../modules/shipping/index.js";
import { buildAdminRoutes as buildNotificationAdminRoutesLazy } from "../modules/notification/wire.js";
import {
  adminRoutes as ordersAdminRoutes,
  orderService,
  storefrontRoutes as ordersStorefrontRoutes,
} from "../modules/orders/index.js";
import type { AppBindings } from "../lib/types.js";

// OpenAPIHono so nested OpenAPIHono routers — health, /v1, and every
// per-module admin/storefront router — propagate into the OpenAPI doc when
// this is mounted on the main app. Each module's `adminRoutes` /
// `storefrontRoutes` export is itself an `OpenAPIHono<AppBindings>`, so
// `.route(...)` walks them when `setupOpenApi(app)` calls `app.doc(...)`.
export function buildRoutes(): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>();
  router.route("/", buildHealthRoutes());
  router.route("/v1", buildV1Routes());

  // Admin and storefront mount at top-level versioned prefixes. As more
  // modules ship, each registers its admin/storefront sub-routers under the
  // same shared prefix.
  router.route("/admin/v1/auth", authAdminRoutes);
  router.route("/storefront/v1/auth", authStorefrontRoutes);
  router.route("/admin/v1", catalogAdminRoutes);
  router.route("/storefront/v1", catalogStorefrontRoutes);
  router.route("/admin/v1", customerAdminRoutes);
  router.route("/storefront/v1", customerStorefrontRoutes);
  router.route("/admin/v1", cartAdminRoutes);
  router.route("/storefront/v1", cartStorefrontRoutes);
  router.route("/admin/v1", checkoutAdminRoutes);
  router.route("/storefront/v1", checkoutStorefrontRoutes);
  router.route("/admin/v1", taxAdminRoutes);
  router.route("/storefront/v1", taxStorefrontRoutes);
  router.route("/admin/v1", shippingAdminRoutes);
  // Fulfillment routes are constructed here (not in the shipping module's
  // index) because they need the orders service injected for the
  // delivered → order.fulfilled cross-module nudge. Building at the
  // registrar avoids the orders ↔ shipping circular import that would
  // otherwise show up at module load.
  router.route(
    "/admin/v1",
    buildShippingAdminFulfillmentRoutes(shippingService, orderService),
  );
  router.route("/storefront/v1", shippingStorefrontRoutes);
  router.route("/admin/v1", buildNotificationAdminRoutesLazy());
  router.route("/admin/v1", ordersAdminRoutes);
  router.route("/storefront/v1", ordersStorefrontRoutes);

  return router;
}
