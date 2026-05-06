/**
 * Liveness and readiness routes.
 *
 *   GET /health  — process is up. Cheap. Always 200.
 *   GET /ready   — dependencies (currently just Postgres) are reachable.
 *                  200 when ready, 503 when not.
 *
 * Intentionally NOT under `/v1/`. These are operator-facing endpoints
 * consumed by orchestrators (Docker, Kubernetes, load balancers) and are not
 * part of the versioned public API surface.
 */
import { Hono } from "hono";
import { pingDatabase } from "../db/client.js";
import type { AppBindings } from "../lib/types.js";

export function buildHealthRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.get("/health", (c) => c.json({ status: "ok" }));

  router.get("/ready", async (c) => {
    const dbOk = await pingDatabase();
    if (!dbOk) {
      return c.json(
        { status: "not_ready", checks: { database: "fail" } },
        503,
      );
    }
    return c.json({ status: "ready", checks: { database: "ok" } });
  });

  return router;
}
