/**
 * Storefront orders routes — customer-facing "my orders" reads.
 *
 * Mounted at `/storefront/v1` from the top-level router.
 *
 * Auth model (v0.1, transitional):
 *   - Customer auth integration is still landing. Until then, the
 *     storefront identifies the caller via an `x-customer-id` header
 *     stand-in. This is INTENTIONALLY a header (not a cookie) so it is
 *     obvious in test traffic and in logs that the binding is provisional.
 *     A 401 is returned when the header is missing — never a 200 with
 *     someone else's orders. The future customer-auth middleware will
 *     replace the header read with a session lookup; the route shapes
 *     do not change.
 *
 *   - Cross-tenant safety: every read scopes by the resolved customer id.
 *     A customer cannot reach another customer's order even if they
 *     guess the order number or the order id, because both detail
 *     lookups verify ownership before returning.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError, UnauthorizedError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import type { OrderService } from "../service.js";
import { listMyOrdersQuerySchema } from "../types.js";
import { parseLocale } from "../../catalog/i18n.js";
import { toWireOrder } from "./wire.js";
import { OrderWire, PaginatedOrderWire } from "./openapi-schemas.js";

const TAG = "orders (storefront)";

const OrderNumberParam = z.object({ orderNumber: z.string().min(1) });

const CUSTOMER_HEADER = "x-customer-id";

function requireCustomerId(c: {
  req: { header: (k: string) => string | undefined };
}): string {
  const value = c.req.header(CUSTOMER_HEADER);
  if (!value || value.trim().length === 0) {
    throw new UnauthorizedError(
      "Customer authentication is required for this endpoint.",
    );
  }
  return value.trim();
}

function readLocale(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): string {
  const fromQuery = c.req.query("locale");
  if (fromQuery) return parseLocale(fromQuery);
  return parseLocale(c.req.header("accept-language"));
}

export function buildOrdersStorefrontRoutes(
  service: OrderService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.openapi(
    createRoute({
      method: "get",
      path: "/customer/me/orders",
      tags: [TAG],
      summary: "List my orders",
      description:
        "Returns the current customer's orders, newest first. Identifies the caller via the `x-customer-id` header until customer-auth integration lands.",
      request: { query: listMyOrdersQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedOrderWire } },
          description: "Page of the current customer's orders.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Customer authentication required."),
      },
    }),
    async (c) => {
      const customerId = requireCustomerId(c);
      const query = c.req.valid("query");
      const locale = readLocale(c);
      const result = await service.listCustomerOrders(customerId, query, {
        locale,
      });
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
      path: "/customer/me/orders/{orderNumber}",
      tags: [TAG],
      summary: "Get my order by order_number",
      description:
        "Looks up by the human-readable `order_number` (friendlier for shareable URLs). Returns 404 if the order does not exist OR does not belong to the calling customer (no existence-leak across customers).",
      request: { params: OrderNumberParam },
      responses: {
        200: {
          content: { "application/json": { schema: OrderWire } },
          description: "Order owned by the current customer.",
        },
        401: errorResponse("Customer authentication required."),
        404: errorResponse("Order not found."),
      },
    }),
    async (c) => {
      const customerId = requireCustomerId(c);
      const locale = readLocale(c);
      const order = await service.getOrderByNumber(
        c.req.param("orderNumber"),
        { locale },
      );
      // Refuse the read with 404 (not 403) when the order belongs to a
      // different customer — surfacing 403 would leak existence of
      // foreign-customer orders to a probing client.
      if (!order || order.customerId !== customerId) {
        throw new NotFoundError("Order not found.");
      }
      return c.json(toWireOrder(order), 200);
    },
  );

  return router;
}
