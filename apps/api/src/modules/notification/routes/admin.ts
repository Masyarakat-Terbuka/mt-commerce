/**
 * Admin notification routes — read-only audit log over `notifications`.
 *
 * Mounted at `/admin/v1` from the top-level router. Auth gating mirrors
 * the rest of the admin surface: every route requires a session-
 * authenticated staff user; the role gate accepts `owner | admin |
 * staff`. (`viewer` is excluded for parity with cart/checkout admin
 * routers, even though these endpoints are read-only — operators
 * inspecting customer notifications need staff-level access because the
 * audit log is PII-bearing.)
 *
 * No mutating endpoints are exposed. Sends happen through the service
 * directly (event listeners, auth's verification email path); admins
 * resending a notification is out of scope for v0.1.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { NotificationService } from "../service.js";
import { listNotificationsQuerySchema } from "../types.js";
import { toWireNotification } from "./wire.js";
import { PaginatedNotificationWire } from "./openapi-schemas.js";

const TAG = "notification (admin)";

export function buildNotificationAdminRoutes(
  service: NotificationService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/notifications",
      tags: [TAG],
      summary: "List notifications (audit log)",
      description:
        "Paginated list of every send attempt. Filter by `channel`, `kind`, and/or `status`.",
      request: { query: listNotificationsQuerySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: PaginatedNotificationWire },
          },
          description: "Page of notifications.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listSent(
        {
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        { page: query.page, pageSize: query.pageSize },
      );
      return c.json(
        {
          data: result.data.map(toWireNotification),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
        200,
      );
    },
  );

  return router;
}
