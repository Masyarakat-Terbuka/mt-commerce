/**
 * Admin checkout routes — staff-facing list/detail + audit-trail readers.
 *
 * Mounted at `/admin/v1` from the top-level router. Auth gating mirrors
 * the cart admin router: every route requires a session-authenticated
 * staff user; the role gate accepts `owner | admin | staff` (viewer is
 * excluded for parity with the rest of the admin surface, even though
 * these endpoints are read-only).
 *
 * No mutating endpoints are exposed here — admins inspecting a checkout
 * mid-flight do not transition states from the admin app. Cancellation
 * uses the storefront `cancel` route on behalf of the customer, with
 * appropriate auditing once the auth integration matures.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { CheckoutService } from "../service.js";
import { listCheckoutsQuerySchema } from "../types.js";
import { toWireCheckout, toWireCheckoutEvent } from "./wire.js";
import {
  CheckoutEventListEnvelope,
  CheckoutWire,
  PaginatedCheckoutWire,
} from "./openapi-schemas.js";

const TAG = "checkout (admin)";

const IdParam = z.object({ id: z.string().min(1) });

export function buildCheckoutAdminRoutes(
  service: CheckoutService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/checkouts",
      tags: [TAG],
      summary: "List checkouts",
      description: "Paginated list. Filter by `state` and `customerId`.",
      request: { query: listCheckoutsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedCheckoutWire } },
          description: "Page of checkouts.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listCheckouts(query);
      return c.json(
        {
          data: result.data.map(toWireCheckout),
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
      path: "/checkouts/{id}",
      tags: [TAG],
      summary: "Get a checkout by id",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CheckoutWire } },
          description: "Checkout.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const checkout = await service.getCheckout(c.req.param("id"));
      if (!checkout) throw new NotFoundError("Checkout not found.");
      return c.json(toWireCheckout(checkout), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/checkouts/{id}/events",
      tags: [TAG],
      summary: "List state-transition events for a checkout",
      description:
        "Audit trail of checkout state transitions. Returns 404 if the checkout id does not exist (rather than an empty list, which could mask a typo).",
      request: { params: IdParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: CheckoutEventListEnvelope },
          },
          description: "Events.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Checkout not found."),
      },
    }),
    async (c) => {
      const checkout = await service.getCheckout(c.req.param("id"));
      if (!checkout) throw new NotFoundError("Checkout not found.");
      const eventRows = await service.listEvents(checkout.id);
      return c.json({ data: eventRows.map(toWireCheckoutEvent) }, 200);
    },
  );

  return router;
}
