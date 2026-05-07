/**
 * Admin cart routes — staff-facing list/detail over carts plus the
 * "abandon" override. Mounted at `/admin/v1` from the top-level router.
 *
 * Auth: every route in this file requires a session-authenticated staff
 * user. The role gate accepts `owner`, `admin`, and `staff` — `viewer` is
 * intentionally excluded because the abandon endpoint is mutating; the
 * read-only endpoints sit alongside the mutating one and we keep the gate
 * uniform across the router. (The catalog and customer admin routers use
 * the same set; matching them keeps reasoning predictable.)
 *
 * OpenAPI: routes are declared via `createRoute`/`router.openapi(...)` so
 * each shows up in `/openapi.json`. The standard error envelope renders
 * for validation failures, missing auth, and forbidden roles.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { CartService } from "../service.js";
import { listCartsQuerySchema } from "../types.js";
import { toWireCart } from "./wire.js";
import { CartWire, PaginatedCartWire } from "./openapi-schemas.js";

const TAG = "cart (admin)";

const IdParam = z.object({ id: z.string().min(1) });

export function buildCartAdminRoutes(
  service: CartService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  // Gate every route. The auth module's middlewares populate
  // c.var.authUser and check the staff profile's role.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/carts",
      tags: [TAG],
      summary: "List carts",
      description:
        "Paginated cart list. Supports filtering by `status` and `customerId`. Each entry includes precomputed totals.",
      request: { query: listCartsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedCartWire } },
          description: "Page of carts.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listCarts(query);
      return c.json(
        {
          data: result.data.map((cart) =>
            toWireCart(cart, service.getTotals(cart)),
          ),
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
      path: "/carts/{id}",
      tags: [TAG],
      summary: "Get a cart by id",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Cart with totals.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const cart = await service.getCartById(c.req.param("id"));
      if (!cart) throw new NotFoundError("Cart not found.");
      return c.json(toWireCart(cart, service.getTotals(cart)), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/carts/{id}/abandon",
      tags: [TAG],
      summary: "Mark a cart as abandoned (override)",
      description:
        "Force-transitions an active cart to `abandoned`. Refused for converted carts.",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Updated cart.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
        409: errorResponse("Cart cannot be abandoned in its current state."),
      },
    }),
    async (c) => {
      const cart = await service.markAbandoned(c.req.param("id"));
      return c.json(toWireCart(cart, service.getTotals(cart)), 200);
    },
  );

  return router;
}
