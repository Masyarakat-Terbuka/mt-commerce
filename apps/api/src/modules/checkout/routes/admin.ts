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
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { CheckoutService } from "../service.js";
import { listCheckoutsQuerySchema } from "../types.js";
import { toWireCheckout, toWireCheckoutEvent } from "./wire.js";

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

export function buildCheckoutAdminRoutes(
  service: CheckoutService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.get("/checkouts", async (c) => {
    const query = parseOrThrow(
      listCheckoutsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const result = await service.listCheckouts(query);
    return c.json({
      data: result.data.map(toWireCheckout),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.get("/checkouts/:id", async (c) => {
    const checkout = await service.getCheckout(c.req.param("id"));
    if (!checkout) throw new NotFoundError("Checkout not found.");
    return c.json(toWireCheckout(checkout));
  });

  router.get("/checkouts/:id/events", async (c) => {
    // Existence check so a non-existent id returns 404 rather than an
    // empty list (which could mask a typo'd id).
    const checkout = await service.getCheckout(c.req.param("id"));
    if (!checkout) throw new NotFoundError("Checkout not found.");
    const eventRows = await service.listEvents(checkout.id);
    return c.json({
      data: eventRows.map(toWireCheckoutEvent),
    });
  });

  return router;
}
