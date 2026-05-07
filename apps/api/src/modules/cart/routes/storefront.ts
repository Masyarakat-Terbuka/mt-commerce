/**
 * Storefront cart routes — public, unauthenticated cart management plus
 * `/customer/me/cart` endpoints for authenticated buyers. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Auth — TWO categories:
 *
 *   1. `POST /carts`, `GET /carts/:id`, items + clear — public.
 *      Anyone with a cart id can act on it. Cart ids are unguessable ULIDs;
 *      treat the id itself as the bearer token (the catalog/storefront
 *      pattern). When auth lands, an authenticated cart will additionally
 *      be ownership-checked against `c.var.authUser`-derived customer id.
 *
 *   2. `/customer/me/cart` — requires an authenticated customer.
 *      TODO requireAuth(): the auth module will populate `c.var.authUser`,
 *      from which we will resolve the customer via `getCustomerByAuthUserId`.
 *      Until that lands, these routes accept a stand-in `x-customer-id`
 *      header (development-only). Production builds MUST replace this with
 *      auth-derived resolution.
 *
 * Conventions match the catalog/customer storefront routers:
 *   - Zod-validated bodies
 *   - `ValidationError` for parse failures
 *   - wire helpers for JSON shaping
 */
import { Hono, type Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import type { CartService } from "../service.js";
import {
  addItemSchema,
  createCartSchema,
  updateItemQuantitySchema,
} from "../types.js";
import { toWireCart } from "./wire.js";

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }
}

function parseOrThrow<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      "Request validation failed.",
      issuesToDetails(result.error.issues),
    );
  }
  return result.data as z.infer<S>;
}

/**
 * TEMPORARY: resolve the current customer id from the `x-customer-id`
 * request header. Replaced by `c.var.authUser`-driven lookup once auth
 * lands. Same pattern as the customer module's storefront router; behavior
 * matches so clients that wire the stand-in today continue to work
 * tomorrow with only their auth setup changing.
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
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // -------------------------------------------------------------------
  // Cart CRUD — public; ULID id is the bearer
  // -------------------------------------------------------------------

  router.post("/carts", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createCartSchema, raw);
    const cart = await service.createGuestCart(input.currency);
    return c.json(toWireCart(cart, service.getTotals(cart)), 201);
  });

  router.get("/carts/:id", async (c) => {
    const cart = await service.getCartById(c.req.param("id"));
    if (!cart) throw new NotFoundError("Cart not found.");
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  router.post("/carts/:id/items", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(addItemSchema, raw);
    const cart = await service.addItem(c.req.param("id"), input);
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  router.patch("/carts/:id/items/:itemId", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(updateItemQuantitySchema, raw);
    const cart = await service.updateItemQuantity(
      c.req.param("id"),
      c.req.param("itemId"),
      input.quantity,
    );
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  router.delete("/carts/:id/items/:itemId", async (c) => {
    const cart = await service.removeItem(
      c.req.param("id"),
      c.req.param("itemId"),
    );
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  router.post("/carts/:id/clear", async (c) => {
    const cart = await service.clear(c.req.param("id"));
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  // -------------------------------------------------------------------
  // /customer/me/cart — TODO requireAuth()
  // -------------------------------------------------------------------

  router.get("/customer/me/cart", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const cart = await service.getActiveCartForCustomer(customerId);
    if (!cart) throw new NotFoundError("No active cart for this customer.");
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  /**
   * Idempotent-ish: if the customer already has an active cart, return it
   * (200) instead of creating a second one. Otherwise create a new active
   * cart bound to the customer (201). Currency comes from the request body
   * because v0.1 has no per-customer default currency stored anywhere; the
   * storefront passes its locale's currency.
   */
  router.post("/customer/me/cart", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createCartSchema, raw);

    const existing = await service.getActiveCartForCustomer(customerId);
    if (existing) {
      return c.json(toWireCart(existing, service.getTotals(existing)));
    }
    const cart = await service.createCustomerCart(customerId, input.currency);
    return c.json(toWireCart(cart, service.getTotals(cart)), 201);
  });

  return router;
}
