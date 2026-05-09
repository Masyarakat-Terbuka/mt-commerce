/**
 * Storefront orders routes — customer-facing "my orders" reads.
 *
 * Mounted at `/storefront/v1` from the top-level router.
 *
 * Auth model:
 *   - Every `/customer/me/orders/*` route is gated by `requireAuth()`.
 *     The auth middleware populates `c.var.authUser`; this router
 *     resolves the domain customer via
 *     `customerService.getCustomerByAuthUserId`. A signed-in auth_user
 *     without a customer profile gets a 404 with the
 *     `customer_not_provisioned` code.
 *
 *   - Cross-tenant safety: every read scopes by the resolved customer id.
 *     A customer cannot reach another customer's order even if they
 *     guess the order number or the order id, because both detail
 *     lookups verify ownership before returning.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { getAuthedUser, requireAuth } from "../../auth/index.js";
import type { CustomerService } from "../../customer/index.js";
import type { OrderService } from "../service.js";
import { listMyOrdersQuerySchema } from "../types.js";
import { parseLocale } from "../../catalog/i18n.js";
import { toWireOrder } from "./wire.js";
import { OrderWire, PaginatedOrderWire } from "./openapi-schemas.js";

const TAG = "orders (storefront)";

const OrderNumberParam = z.object({ orderNumber: z.string().min(1) });

/**
 * Resolve the domain customer id for an authenticated `/customer/me`
 * request. Assumes `requireAuth()` has populated `c.var.authUser`.
 *
 * Returns the customer id directly. A signed-in auth_user without a
 * matching customer row triggers a 404 with the same
 * `customer_not_provisioned` code the customer module uses.
 */
async function resolveCurrentCustomerId(
  c: Context<AppBindings>,
  customers: CustomerService,
): Promise<string> {
  const user = getAuthedUser(c);
  const customer = await customers.getCustomerByAuthUserId(user.id);
  if (!customer) {
    throw new NotFoundError("Customer profile not found.", {
      code: "customer_not_provisioned",
      authUserId: user.id,
    });
  }
  return customer.id;
}

function readLocale(c: {
  req: {
    query: (k: string) => string | undefined;
    header: (k: string) => string | undefined;
  };
}): string {
  const fromQuery = c.req.query("locale");
  if (fromQuery) return parseLocale(fromQuery);
  return parseLocale(c.req.header("accept-language"));
}

export function buildOrdersStorefrontRoutes(
  service: OrderService,
  customers: CustomerService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.use("/customer/me/orders", requireAuth());
  router.use("/customer/me/orders/*", requireAuth());

  router.openapi(
    createRoute({
      method: "get",
      path: "/customer/me/orders",
      tags: [TAG],
      summary: "List my orders",
      description:
        "Returns the current customer's orders, newest first. Identifies the caller via the session cookie's auth_user (resolved via `customers.auth_user_id`).",
      request: { query: listMyOrdersQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedOrderWire } },
          description: "Page of the current customer's orders.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Customer authentication required."),
        404: errorResponse("Customer profile not provisioned for this user."),
      },
    }),
    async (c) => {
      const customerId = await resolveCurrentCustomerId(c, customers);
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
      const customerId = await resolveCurrentCustomerId(c, customers);
      const locale = readLocale(c);
      const order = await service.getOrderByNumber(c.req.param("orderNumber"), {
        locale,
      });
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
