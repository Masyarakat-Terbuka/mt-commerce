/**
 * Admin fulfillment routes — staff-facing lifecycle controls.
 *
 * Mounted at `/admin/v1` from the top-level router. Auth gating mirrors
 * the orders admin router: every route requires a session-authenticated
 * staff user; the role gate accepts `owner | admin | staff`.
 *
 * Cross-module composition (delivered → order.fulfilled):
 *   When a fulfillment transitions to `delivered`, this route layer also
 *   nudges the parent order from `paid → fulfilled` via the orders
 *   service. We do this at the *routes* layer (rather than reaching from
 *   the shipping service into the orders service) so each module's
 *   service stays focused on its own state machine and bounded context
 *   (per ADR-0005). An invalid order transition (the order was already
 *   `fulfilled`, `cancelled`, or `refunded`) is logged and ignored —
 *   the fulfillment-side write is still authoritative and we don't want
 *   the operator's "mark delivered" to fail because the order was already
 *   in the target state.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError } from "../../../lib/errors.js";
import { childLogger } from "../../../lib/logger.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { getAuthedUser, requireAuth, requireRole } from "../../auth/index.js";
import type { OrderService } from "../../orders/index.js";
import type { ShippingService } from "../service.js";
import {
  cancelFulfillmentSchema,
  listFulfillmentsQuerySchema,
  markFulfillmentDeliveredSchema,
  markFulfillmentShippedSchema,
  setFulfillmentTrackingSchema,
} from "../types.js";
import { toWireFulfillment } from "./wire.js";
import {
  FulfillmentListEnvelope,
  FulfillmentWire,
} from "./openapi-schemas.js";

const TAG = "fulfillments (admin)";

const log = childLogger("shipping.routes.admin");

const IdParam = z.object({ id: z.string().min(1) });

export function buildShippingAdminFulfillmentRoutes(
  shipping: ShippingService,
  orders: OrderService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/fulfillments",
      tags: [TAG],
      summary: "List fulfillments for an order",
      description:
        "v0.1 expects exactly one fulfillment per order; the list shape leaves room for split shipments later.",
      request: { query: listFulfillmentsQuerySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: FulfillmentListEnvelope },
          },
          description: "Fulfillments for the order.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const { orderId } = c.req.valid("query");
      const fulfillments = await shipping.listFulfillmentsByOrderId(orderId);
      return c.json(
        { data: fulfillments.map(toWireFulfillment) },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/fulfillments/{id}",
      tags: [TAG],
      summary: "Get a fulfillment by id",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: FulfillmentWire } },
          description: "Fulfillment.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const f = await shipping.getFulfillmentById(c.req.param("id"));
      if (!f) throw new NotFoundError("Fulfillment not found.");
      return c.json(toWireFulfillment(f), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/fulfillments/{id}/tracking",
      tags: [TAG],
      summary: "Set or clear the tracking code",
      description:
        "Updates only the tracking code; does not change status. Pass `trackingCode: null` to clear.",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: setFulfillmentTrackingSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: FulfillmentWire } },
          description: "Updated fulfillment.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Fulfillment not found."),
        409: errorResponse("Cannot set tracking on a cancelled fulfillment."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = getAuthedUser(c);
      const f = await shipping.setTracking(c.req.param("id"), {
        actor: { kind: "staff", userId: user.id },
        trackingCode: input.trackingCode,
      });
      return c.json(toWireFulfillment(f), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/fulfillments/{id}/mark-shipped",
      tags: [TAG],
      summary: "Mark a fulfillment as shipped",
      description:
        "Transitions `pending → shipped` and stamps `tracked_at`. Optionally accepts a tracking code in the same request.",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: markFulfillmentShippedSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: FulfillmentWire } },
          description: "Shipped fulfillment.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Fulfillment not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = getAuthedUser(c);
      const f = await shipping.markShipped(c.req.param("id"), {
        actor: { kind: "staff", userId: user.id },
        ...(input.trackingCode !== undefined
          ? { trackingCode: input.trackingCode }
          : {}),
      });
      return c.json(toWireFulfillment(f), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/fulfillments/{id}/mark-delivered",
      tags: [TAG],
      summary: "Mark a fulfillment as delivered",
      description:
        "Transitions `shipped → delivered`, stamps `delivered_at`, and best-effort transitions the parent order `paid → fulfilled`. The order-side transition is silently skipped if the order is no longer in `paid` (e.g. it was cancelled or refunded between hand-off and delivery).",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: markFulfillmentDeliveredSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: FulfillmentWire } },
          description: "Delivered fulfillment.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Fulfillment not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const f = await shipping.markDelivered(c.req.param("id"), {
        actor: { kind: "staff", userId: user.id },
      });

      // Best-effort cross-module nudge: drive the parent order to
      // `fulfilled` if it is currently `paid`. Any other source state
      // means the transition is either already done (`fulfilled`) or
      // illegal (`cancelled`, `refunded`); both paths land in the catch
      // and the operator-visible result is still success.
      try {
        await orders.transitionStatus(f.orderId, "fulfilled", {
          actorKind: "staff",
          actorId: user.id,
          details: {
            triggeredByFulfillmentId: f.id,
            via: "fulfillment.mark-delivered",
          },
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          // Expected when the order is not in `paid` (already fulfilled,
          // cancelled, refunded). Log at info — this is informational,
          // not an error.
          log.info(
            {
              orderId: f.orderId,
              fulfillmentId: f.id,
              code: (err.details as { code?: string } | undefined)?.code,
            },
            "fulfillment.mark-delivered: parent order transition skipped",
          );
        } else if (err instanceof NotFoundError) {
          // The fulfillment exists but the order vanished — would be a
          // referential-integrity bug. Log warn and continue; the
          // fulfillment write already committed.
          log.warn(
            { orderId: f.orderId, fulfillmentId: f.id },
            "fulfillment.mark-delivered: parent order not found",
          );
        } else {
          // Anything else is an unexpected failure mode; let it bubble so
          // the operator sees a 500 and we surface it in the logs. The
          // fulfillment write committed independently — that's the
          // intended consistency boundary.
          throw err;
        }
      }

      return c.json(toWireFulfillment(f), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/fulfillments/{id}/cancel",
      tags: [TAG],
      summary: "Cancel a fulfillment",
      description:
        "Transitions to `cancelled` from `pending` or `shipped`. Captures an optional reason on the audit row. Does NOT cancel the parent order.",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: cancelFulfillmentSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: FulfillmentWire } },
          description: "Cancelled fulfillment.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Fulfillment not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const user = getAuthedUser(c);
      const f = await shipping.cancel(c.req.param("id"), {
        actor: { kind: "staff", userId: user.id },
        reason: input.reason ?? null,
      });
      return c.json(toWireFulfillment(f), 200);
    },
  );

  return router;
}
