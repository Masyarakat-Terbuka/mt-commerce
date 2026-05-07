/**
 * Notification wire-up. Builds the route singletons used by the top-level
 * router. Mirrors `apps/api/src/modules/catalog/routes/wire.ts` style —
 * every module exposes a `wire.ts` that lazily resolves the runtime
 * service so tests can install fakes without forcing this module to
 * construct the SMTP transport.
 *
 * The default singleton is constructed via `getNotificationService()` so
 * tests that never touch the notification module do not pay the SMTP
 * factory's production-mode constructor throw.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings } from "../../lib/types.js";
import { buildNotificationAdminRoutes } from "./routes/admin.js";
import { getNotificationService } from "./service.js";

export function buildAdminRoutes(): OpenAPIHono<AppBindings> {
  return buildNotificationAdminRoutes(getNotificationService());
}
