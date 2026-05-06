/**
 * OpenAPI document and Swagger UI setup.
 *
 * The OpenAPI document is the public contract of the API. We generate it from
 * Zod schemas via `@hono/zod-openapi` so the document and the runtime
 * validation never drift apart. Routes that opt into the spec register an
 * `OpenAPIHono` route with a Zod schema.
 *
 * Routes built with plain `Hono` (like the current health and ping routes)
 * are not in the spec yet. They will move to `@hono/zod-openapi` as each
 * module is fleshed out.
 *
 * Swagger UI is mounted at `/docs` only when `NODE_ENV === "development"`.
 * Production deployments should publish a static OpenAPI document elsewhere
 * rather than serving the explorer.
 *
 * Error handling: the sub-app inherits the same `errorHandler` as the parent.
 * Without this, an exception thrown by the OpenAPI document generator (or any
 * route registered on the sub-app later) would bypass the standard error
 * envelope and produce an inconsistent response.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import type { Hono } from "hono";
import { env } from "./env.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { AppBindings } from "./types.js";

const OPENAPI_PATH = "/openapi.json";
const DOCS_PATH = "/docs";

export function setupOpenApi(app: Hono<AppBindings>): void {
  // Use a separate OpenAPIHono instance to host the spec endpoint. We could
  // migrate the entire app to OpenAPIHono later; doing it incrementally keeps
  // the current Hono types simple. Parametrize by `AppBindings` so the
  // shared `errorHandler` types match.
  const openApiApp = new OpenAPIHono<AppBindings>();

  openApiApp.doc(OPENAPI_PATH, {
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

  // Errors thrown inside the OpenAPI sub-app must be caught by the same
  // standard error boundary as the rest of the API. Sub-apps mounted via
  // `app.route(...)` do NOT inherit `app.onError` automatically, so we wire
  // the same handler here.
  openApiApp.onError(errorHandler);

  app.route("/", openApiApp);

  if (env.isDev) {
    app.get(DOCS_PATH, swaggerUI({ url: OPENAPI_PATH }));
  }
}
