/**
 * Top-level route registrar.
 *
 *   /health, /ready          operator-facing, unversioned
 *   /v1/...                  public, versioned API surface
 *   /openapi.json, /docs     mounted by `setupOpenApi` in app.ts
 */
import { Hono } from "hono";
import { buildHealthRoutes } from "./health.js";
import { buildV1Routes } from "./v1/index.js";
import type { AppBindings } from "../lib/types.js";

export function buildRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.route("/", buildHealthRoutes());
  router.route("/v1", buildV1Routes());
  return router;
}
