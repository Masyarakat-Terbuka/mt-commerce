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
 * Conventions match the catalog/customer admin routers:
 *   - Bodies (where present) are validated through Zod schemas.
 *   - Validation failures throw `ValidationError` so the standard error
 *     handler renders the consistent envelope.
 *   - Domain types are converted to wire shapes by `toWireCart`, which
 *     embeds `getTotals(cart)` so admins see the breakdown immediately.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { CartService } from "../service.js";
import { listCartsQuerySchema } from "../types.js";
import { toWireCart } from "./wire.js";

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

export function buildCartAdminRoutes(
  service: CartService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // Gate every route. The auth module's middlewares populate
  // c.var.authUser and check the staff profile's role.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.get("/carts", async (c) => {
    const query = parseOrThrow(
      listCartsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const result = await service.listCarts(query);
    return c.json({
      data: result.data.map((cart) =>
        toWireCart(cart, service.getTotals(cart)),
      ),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.get("/carts/:id", async (c) => {
    const cart = await service.getCartById(c.req.param("id"));
    if (!cart) throw new NotFoundError("Cart not found.");
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  router.post("/carts/:id/abandon", async (c) => {
    const cart = await service.markAbandoned(c.req.param("id"));
    return c.json(toWireCart(cart, service.getTotals(cart)));
  });

  return router;
}
