/**
 * Storefront cart routes — public, unauthenticated cart management plus
 * `/customer/me/cart` endpoints for authenticated buyers. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Auth — TWO categories:
 *
 *   1. `POST /carts`, `GET /carts/:id`, items + clear — public.
 *      Anyone with a cart id can act on it. Cart ids are unguessable ULIDs;
 *      the id itself is the bearer token (the catalog/storefront pattern).
 *      When auth lands, an authenticated cart will additionally be
 *      ownership-checked against `c.var.authUser`-derived customer id.
 *
 *   2. `/customer/me/cart` — requires an authenticated customer.
 *      TODO requireAuth(): the auth module will populate `c.var.authUser`,
 *      from which we will resolve the customer via `getCustomerByAuthUserId`.
 *      Until that lands, these routes accept a stand-in `x-customer-id`
 *      header (development-only).
 *
 * OpenAPI: each route is declared via `createRoute`/`router.openapi(...)`.
 * Bodies are validated with the Zod schemas exported from `types.ts`;
 * failures throw `ZodError`, caught by the global error handler.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { NotFoundError, UnauthorizedError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import type { Cart } from "../types.js";
import type { CartService, GetTotalsOptions } from "../service.js";
import {
  addItemSchema,
  createCartSchema,
  updateItemQuantitySchema,
} from "../types.js";
import { toWireCart } from "./wire.js";
import { CartWire } from "./openapi-schemas.js";

/**
 * Resolves the `taxRate` option for `getTotals` for a given currency. Per
 * ADR-0005 (modular monolith), the cart routes do not import the tax
 * module directly — the route builder accepts a resolver function so the
 * dependency direction stays cart → opaque function (and the test surface
 * stays a single-function fake).
 *
 * Returning `null` is the documented fallback path: `getTotals` then
 * applies `env.taxPpnRate`. Throws bubble up as 5xx — the route layer
 * does not swallow them; an unreachable tax service should surface
 * loudly so operators see it on the dashboards rather than silently
 * shipping carts with wrong totals.
 */
export type TaxRateResolver = (
  currency: string,
) => Promise<GetTotalsOptions["taxRate"] | null>;

const noTaxResolver: TaxRateResolver = async () => null;

const TAG = "cart (storefront)";

const IdParam = z.object({ id: z.string().min(1) });
const IdItemParam = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
});

/**
 * TEMPORARY: resolve the current customer id from the `x-customer-id`
 * request header. Replaced by `c.var.authUser`-driven lookup once auth
 * lands. Same pattern as the customer storefront router.
 */
async function resolveCurrentCustomerId(
  c: Context<AppBindings>,
): Promise<string> {
  const headerId = c.req.header("x-customer-id");
  if (!headerId) {
    throw new UnauthorizedError(
      "Missing customer context. (Stand-in `x-customer-id` header expected until auth lands.)",
    );
  }
  return headerId;
}

export function buildCartStorefrontRoutes(
  service: CartService,
  resolveTaxRate: TaxRateResolver = noTaxResolver,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  /**
   * Resolve the tax rate for this cart's currency once per request and
   * pass it to `getTotals`. Per-request resolution (not cart-row caching)
   * is deliberate: operators may flip the default rate at any time via
   * the admin UI, and a cached value would silently apply the wrong rate
   * to a cart created before the flip. The lookup is a single SELECT
   * against a partial unique index — the tax module's README documents
   * this as the cart-totals hot path.
   */
  async function totalsFor(cart: Cart) {
    const taxRate = await resolveTaxRate(cart.currency);
    return service.getTotals(cart, taxRate ? { taxRate } : undefined);
  }

  // -------------------------------------------------------------------
  // Cart CRUD — public; ULID id is the bearer
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "post",
      path: "/carts",
      tags: [TAG],
      summary: "Create a guest cart",
      description: "Currency is locked at create-time and may not change later.",
      request: {
        body: { content: { "application/json": { schema: createCartSchema } } },
      },
      responses: {
        201: {
          content: { "application/json": { schema: CartWire } },
          description: "Created cart.",
        },
        400: errorResponse("Validation failed."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const cart = await service.createGuestCart(input.currency);
      return c.json(toWireCart(cart, await totalsFor(cart)), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/carts/{id}",
      tags: [TAG],
      summary: "Get a cart by id (public; ULID is the bearer)",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Cart.",
        },
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
      path: "/carts/{id}/items",
      tags: [TAG],
      summary: "Add a line item",
      description:
        "Adding the same variant twice merges into a single line; the latest add's price wins.",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: addItemSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Updated cart.",
        },
        400: errorResponse("Validation failed."),
        404: errorResponse("Cart or variant not found."),
        409: errorResponse("Currency mismatch or cart not active."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const cart = await service.addItem(c.req.param("id"), input);
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/carts/{id}/items/{itemId}",
      tags: [TAG],
      summary: "Set a line item's quantity",
      description: "`quantity: 0` removes the line.",
      request: {
        params: IdItemParam,
        body: {
          content: { "application/json": { schema: updateItemQuantitySchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Updated cart.",
        },
        400: errorResponse("Validation failed."),
        404: errorResponse("Cart or item not found."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const cart = await service.updateItemQuantity(
        c.req.param("id"),
        c.req.param("itemId"),
        input.quantity,
      );
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/carts/{id}/items/{itemId}",
      tags: [TAG],
      summary: "Remove a line item",
      request: { params: IdItemParam },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Updated cart.",
        },
        404: errorResponse("Cart or item not found."),
      },
    }),
    async (c) => {
      const cart = await service.removeItem(
        c.req.param("id"),
        c.req.param("itemId"),
      );
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/carts/{id}/clear",
      tags: [TAG],
      summary: "Remove all items from a cart",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Cleared cart.",
        },
        404: errorResponse("Cart not found."),
        409: errorResponse("Cart is converted and cannot be cleared."),
      },
    }),
    async (c) => {
      const cart = await service.clear(c.req.param("id"));
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  // -------------------------------------------------------------------
  // /customer/me/cart — TODO requireAuth()
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "get",
      path: "/customer/me/cart",
      tags: [TAG],
      summary: "Get the current customer's active cart",
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Active cart.",
        },
        401: errorResponse("Authentication required."),
        404: errorResponse("No active cart."),
      },
    }),
    async (c) => {
      const customerId = await resolveCurrentCustomerId(c);
      const cart = await service.getActiveCartForCustomer(customerId);
      if (!cart) throw new NotFoundError("No active cart for this customer.");
      return c.json(toWireCart(cart, await totalsFor(cart)), 200);
    },
  );

  /**
   * Idempotent-ish: if the customer already has an active cart, return it
   * (200) instead of creating a second one. Otherwise create a new active
   * cart bound to the customer (201).
   *
   * The route declares 201 in its OpenAPI spec because that's the
   * "canonical" outcome; the 200 variant is a documented quirk noted in the
   * description. We render the actual status at runtime based on whether a
   * cart already existed.
   */
  router.openapi(
    createRoute({
      method: "post",
      path: "/customer/me/cart",
      tags: [TAG],
      summary: "Create or reuse the current customer's active cart",
      description:
        "If the customer already has an active cart, returns it with status 200. Otherwise creates a new one and returns 201. Currency comes from the request body; the storefront passes its locale's currency.",
      request: {
        body: { content: { "application/json": { schema: createCartSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CartWire } },
          description: "Existing active cart returned.",
        },
        201: {
          content: { "application/json": { schema: CartWire } },
          description: "Newly created cart.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
      },
    }),
    async (c) => {
      const customerId = await resolveCurrentCustomerId(c);
      const input = c.req.valid("json");
      const existing = await service.getActiveCartForCustomer(customerId);
      if (existing) {
        return c.json(toWireCart(existing, await totalsFor(existing)), 200);
      }
      const cart = await service.createCustomerCart(customerId, input.currency);
      return c.json(toWireCart(cart, await totalsFor(cart)), 201);
    },
  );

  return router;
}
