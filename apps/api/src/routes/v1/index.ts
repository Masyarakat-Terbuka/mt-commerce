/**
 * v1 route registrar. Every public, versioned route mounts under this router.
 * Modules add their own routers here as they ship.
 */
import { Hono } from "hono";
import { buildPingRoutes } from "./ping.js";
import type { AppBindings } from "../../lib/types.js";

export function buildV1Routes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.route("/", buildPingRoutes());
  return router;
}
