/**
 * Admin orders routes — staff-facing list/detail + status transitions.
 *
 * Mounted at `/admin/v1` from the top-level router. Auth gating mirrors
 * the catalog admin router: every route requires a session-authenticated
 * staff user; the role gate accepts `owner | admin | staff` (viewer is
 * excluded for parity).
 *
 * Mutating endpoints capture the actor as `actor_kind = 'staff'` and
 * `actor_id = c.var.authUser.id` on the audit row, so the history makes
 * "who did what" explicit even after the operator's session ends.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { getAuthedUser, requireAuth, requireRole } from "../../auth/index.js";
import type { OrderService } from "../service.js";
import {
  cancelOrderSchema,
  listOrdersQuerySchema,
  transitionOrderSchema,
} from "../types.js";
import { parseLocale } from "../../catalog/i18n.js";
import { toWireOrder, toWireOrderStatusEvent } from "./wire.js";
import {
  OrderEventListEnvelope,
  OrderWire,
  PaginatedOrderWire,
} from "./openapi-schemas.js";

const TAG = "orders (admin)";

const IdParam = z.object({ id: z.string().min(1) });

function readLocale(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): string {
  // Same convention as the catalog read paths: explicit `?locale=` wins,
  // then `Accept-Language`, then the default.
  const fromQuery = c.req.query("locale");
  if (fromQuery) return parseLocale(fromQuery);
  return parseLocale(c.req.header("accept-language"));
}

export function buildOrdersAdminRoutes(
  service: OrderService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/orders",
      tags: [TAG],
      summary: "List orders",
      description:
        "Paginated list. Filter by status, customerId, email, an exact orderNumber (e.g. `ORD-2026-000123`), and a creation date range.",
      request: { query: listOrdersQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedOrderWire } },
          description: "Page of orders.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const locale = readLocale(c);
      const result = await service.listOrders(query, { locale });
      return c.json(
        {
          data: result.data.map(toWireOrder),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/orders/{id}",
      tags: [TAG],
      summary: "Get an order by id, including status history",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: OrderWire } },
          description: "Order.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const locale = readLocale(c);
      const order = await service.getOrderById(c.req.param("id"), { locale });
      if (!order) throw new NotFoundError("Order not found.");
      return c.json(toWireOrder(order), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/orders/{id}/events",
      tags: [TAG],
      summary: "List status-history events for an order",
      description:
        "Returns the audit trail. 404 when the order does not exist (rather than an empty list, which could mask a typo).",
      request: { params: IdParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: OrderEventListEnvelope },
          },
          description: "Events.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Order not found."),
      },
    }),
    async (c) => {
      const events = await service.listStatusHistory(c.req.param("id"));
      return c.json({ data: events.map(toWireOrderStatusEvent) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/orders/{id}/transition",
      tags: [TAG],
      summary: "Transition an order to a new status",
      description:
        "Validates against the order state machine. Allowed transitions are documented in the orders module README.",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: transitionOrderSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: OrderWire } },
          description: "Order with the new status.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Order not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = getAuthedUser(c);
      const locale = readLocale(c);
      const order = await service.transitionStatus(
        c.req.param("id"),
        input.toStatus,
        {
          actorKind: "staff",
          actorId: user.id,
          ...(input.details ? { details: input.details } : {}),
        },
        locale,
      );
      return c.json(toWireOrder(order), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/orders/{id}/cancel",
      tags: [TAG],
      summary: "Cancel an order",
      description:
        "Convenience wrapper around the `cancelled` transition that captures a free-text reason.",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: cancelOrderSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: OrderWire } },
          description: "Cancelled order.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Order not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = getAuthedUser(c);
      const locale = readLocale(c);
      const order = await service.cancelOrder(
        c.req.param("id"),
        {
          actorKind: "staff",
          actorId: user.id,
          reason: input.reason ?? null,
        },
        locale,
      );
      return c.json(toWireOrder(order), 200);
    },
  );

  return router;
}
