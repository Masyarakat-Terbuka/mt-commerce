/**
 * Admin settings routes — staff-facing read + partial update of the
 * singleton `store_settings` row. Mounted at `/admin/v1` from the top-
 * level router.
 *
 * Auth: every route requires a session-authenticated staff user. The role
 * gate accepts `owner|admin|staff` to match the rest of the admin
 * surface; `viewer` is excluded because settings is mutating.
 *
 * The routes are declared via `createRoute`/`router.openapi(...)` so each
 * shows up in `/openapi.json`. Body validation runs through the Zod
 * schema in `../types.ts`; failures throw `ZodError`, caught by the
 * global error handler.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { SettingsService } from "../service.js";
import { updateSettingsSchema } from "../types.js";
import { toWireStoreSettings } from "./wire.js";
import { StoreSettingsWire } from "./openapi-schemas.js";

const TAG = "settings (admin)";

export function buildSettingsAdminRoutes(
  service: SettingsService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: [TAG],
      summary: "Get store settings",
      description:
        "Returns the singleton settings row. The first call lazily inserts the default row, so callers never receive a `not_found` for this endpoint.",
      responses: {
        200: {
          content: { "application/json": { schema: StoreSettingsWire } },
          description: "Settings.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const settings = await service.getSettings();
      return c.json(toWireStoreSettings(settings), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: [TAG],
      summary: "Update store settings",
      description:
        "Partial update. Send only the keys you want to change. Pass `null` to clear an optional field (e.g. `defaultTaxRateId: null`).",
      request: {
        body: {
          content: { "application/json": { schema: updateSettingsSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: StoreSettingsWire } },
          description: "Updated.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const settings = await service.updateSettings(patch);
      return c.json(toWireStoreSettings(settings), 200);
    },
  );

  return router;
}
