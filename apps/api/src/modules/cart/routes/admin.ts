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
import type { Cart } from "../types.js";
import type { CartService } from "../service.js";
import { listCartsQuerySchema } from "../types.js";
import { toWireCart } from "./wire.js";
import { CartWire, PaginatedCartWire } from "./openapi-schemas.js";
import type { TaxRateResolver } from "./storefront.js";

const TAG = "cart (admin)";

const IdParam = z.object({ id: z.string().min(1) });

const noTaxResolver: TaxRateResolver = async () => null;

export function buildCartAdminRoutes(
  service: CartService,
  resolveTaxRate: TaxRateResolver = noTaxResolver,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  // Gate every route. The auth module's middlewares populate
  // c.var.authUser and check the staff profile's role.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  /**
   * Resolve the tax rate for this cart's currency once per request and
   * pass it to `getTotals`. Same rationale as storefront — see
   * `routes/storefront.ts` for the full reasoning.
   *
   * Listing N carts: rates are resolved per-currency, so a 100-cart page
   * does at most one tax-rate lookup per distinct currency in the page
   * (memoised inside the loop). For the v0.1 single-currency setup this
   * collapses to exactly one DB hit per `GET /carts` call.
   */
  async function totalsFor(cart: Cart) {
    const taxRate = await resolveTaxRate(cart.currency);
    return service.getTotals(cart, taxRate ? { taxRate } : undefined);
  }

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

      // Memoise tax-rate lookups by currency so a 100-cart page in a
      // single-currency setup does exactly one tax-module call (and N
      // calls only if the page mixes currencies — multi-currency stores
      // are out of scope for v0.1, so the typical case is N=1).
      const ratesByCurrency = new Map<
        string,
        Awaited<ReturnType<TaxRateResolver>>
      >();
      const distinctCurrencies = new Set(result.data.map((c) => c.currency));
      for (const currency of distinctCurrencies) {
        ratesByCurrency.set(currency, await resolveTaxRate(currency));
      }

      return c.json(
        {
          data: result.data.map((cart) => {
            const taxRate = ratesByCurrency.get(cart.currency) ?? null;
            return toWireCart(
              cart,
              service.getTotals(cart, taxRate ? { taxRate } : undefined),
            );
          }),
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
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
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
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  return router;
}
