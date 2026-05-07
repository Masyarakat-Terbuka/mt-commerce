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
 *
 * These routes are also the first ones registered with `OpenAPIHono`, so the
 * Swagger UI at `/docs` has at least two documented endpoints to render.
 * Per-module routes follow as each module is migrated to the same pattern.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { pingDatabase } from "../db/client.js";
import type { AppBindings } from "../lib/types.js";

const HealthOk = z
  .object({ status: z.literal("ok") })
  .openapi("HealthOk");

const ReadyOk = z
  .object({
    status: z.literal("ready"),
    checks: z.object({ database: z.literal("ok") }),
  })
  .openapi("ReadyOk");

const ReadyFail = z
  .object({
    status: z.literal("not_ready"),
    checks: z.object({ database: z.literal("fail") }),
  })
  .openapi("ReadyFail");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["health"],
  summary: "Liveness check",
  description:
    "Returns 200 with `{ status: \"ok\" }` whenever the API process is up. Does not consult any dependencies.",
  responses: {
    200: {
      content: { "application/json": { schema: HealthOk } },
      description: "Process is up.",
    },
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["health"],
  summary: "Readiness check",
  description:
    "Returns 200 when every checked dependency is reachable (currently just Postgres). Returns 503 otherwise.",
  responses: {
    200: {
      content: { "application/json": { schema: ReadyOk } },
      description: "Ready.",
    },
    503: {
      content: { "application/json": { schema: ReadyFail } },
      description: "Not ready — at least one dependency is unreachable.",
    },
  },
});

export function buildHealthRoutes(): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>();

  router.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));

  router.openapi(readyRoute, async (c) => {
    const dbOk = await pingDatabase();
    if (!dbOk) {
      return c.json(
        { status: "not_ready" as const, checks: { database: "fail" as const } },
        503,
      );
    }
    return c.json(
      { status: "ready" as const, checks: { database: "ok" as const } },
      200,
    );
  });

  return router;
}
