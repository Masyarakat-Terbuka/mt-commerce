/**
 * OpenAPI document and Swagger UI setup.
 *
 * The OpenAPI document is the public contract of the API. We generate it
 * from Zod schemas via `@hono/zod-openapi` so the document and the runtime
 * validation never drift apart. Routes opt into the spec by registering an
 * `OpenAPIHono` route with a Zod schema (`.openapi(route, handler)`).
 *
 * `app` is itself an `OpenAPIHono` (see `app.ts`), so calling `.doc()` here
 * walks every route registered through `.openapi(...)` on the app or any
 * nested OpenAPIHono router. Plain Hono routes mounted via `.route(...)`
 * still serve traffic; they simply do not appear in the document.
 *
 * Coverage as of the OpenAPIHono migration:
 *
 *   - Documented: `/health`, `/ready`, `/v1/ping`, and the full per-module
 *     surfaces under `/admin/v1` and `/storefront/v1` for the catalog,
 *     customer, auth, cart, and checkout modules.
 *
 *   - Not documented (intentional exclusion): Better Auth's `/api/auth/*`
 *     handler. Better Auth manages its own routes — sign-up, sign-in,
 *     sign-out, forget-password, reset-password, verify-email,
 *     get-session — and they are mounted in `app.ts` as a single
 *     framework-recommended `app.all("/api/auth/*", ...)`. We do not
 *     re-describe them in our spec because the canonical reference for
 *     Better Auth lives in its own documentation, and recreating it here
 *     would just be a copy that drifts from the framework's behavior.
 *     Custom auth-related endpoints we own (e.g. `/admin/v1/auth/me`,
 *     API-key issuance) are documented through the auth module's
 *     OpenAPIHono routers like every other module.
 *
 * Swagger UI is mounted at `/docs` only when `NODE_ENV === "development"`.
 * Production deployments should publish a static OpenAPI document elsewhere
 * rather than serving the explorer.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { env } from "./env.js";
import type { AppBindings } from "./types.js";

const OPENAPI_PATH = "/openapi.json";
const DOCS_PATH = "/docs";

export function setupOpenApi(app: OpenAPIHono<AppBindings>): void {
  app.doc(OPENAPI_PATH, {
    openapi: "3.1.0",
    info: {
      title: "mt-commerce API",
      version: "0.0.1",
      description:
        "Open-source headless commerce platform for Indonesia. " +
        "This document describes the public HTTP surface; routes will be " +
        "fleshed out as each module ships.",
    },
    servers: [{ url: `http://localhost:${env.port}`, description: "local" }],
  });

  if (env.isDev) {
    app.get(DOCS_PATH, swaggerUI({ url: OPENAPI_PATH }));
  }
}
