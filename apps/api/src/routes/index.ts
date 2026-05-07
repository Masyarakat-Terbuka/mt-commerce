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
import { Hono } from "hono";
import { buildHealthRoutes } from "./health.js";
import { buildV1Routes } from "./v1/index.js";
import { adminRoutes as catalogAdminRoutes, storefrontRoutes as catalogStorefrontRoutes } from "../modules/catalog/index.js";
import { adminRoutes as authAdminRoutes, storefrontRoutes as authStorefrontRoutes } from "../modules/auth/index.js";
import { adminRoutes as customerAdminRoutes, storefrontRoutes as customerStorefrontRoutes } from "../modules/customer/index.js";
import { adminRoutes as cartAdminRoutes, storefrontRoutes as cartStorefrontRoutes } from "../modules/cart/index.js";
import type { AppBindings } from "../lib/types.js";

export function buildRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
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

  return router;
}
