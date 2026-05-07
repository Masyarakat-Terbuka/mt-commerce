/**
 * Storefront checkout routes — public, ULID-bearer access pattern.
 *
 * Mounted at `/storefront/v1` from the top-level router. Anyone with a
 * checkout id can act on the checkout (matches the cart pattern: the
 * checkout id is the bearer token). When the customer-auth integration
 * lands, the `/customer/me/checkouts` family can be added; v0.1 keeps the
 * surface narrow and delegates ownership scoping to the cart's bearer
 * model.
 *
 * Idempotency: the completing transition is the canonical idempotent
 * endpoint. The `requireIdempotencyKey` middleware enforces the header
 * and dedups replays. Other transitions are NOT guarded — they are safe
 * to retry because they are state-machine writes that either succeed
 * (no-op on repeat) or fail with `invalid_transition`.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import {
  buildIdempotencyKeyTestMiddleware,
  requireIdempotencyKey as defaultRequireIdempotencyKey,
  type IdempotencyStore,
} from "../../../middleware/idempotency.js";
import type { CheckoutService } from "../service.js";
import {
  cancelCheckoutSchema,
  completeCheckoutSchema,
  setAddressesSchema,
  setShippingSchema,
  startCheckoutSchema,
} from "../types.js";
import {
  toWireCheckout,
  toWireOrderIntent,
} from "./wire.js";

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

export interface BuildCheckoutStorefrontOptions {
  /**
   * Test seam — inject a fake idempotency store so route-level tests do
   * not need a real database. Production callers omit this.
   */
  idempotencyStore?: IdempotencyStore;
}

export function buildCheckoutStorefrontRoutes(
  service: CheckoutService,
  options: BuildCheckoutStorefrontOptions = {},
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  const requireIdempotencyKey = options.idempotencyStore
    ? buildIdempotencyKeyTestMiddleware(options.idempotencyStore)
    : defaultRequireIdempotencyKey;

  // POST /checkouts — start a checkout
  router.post("/checkouts", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(startCheckoutSchema, raw);
    const checkout = await service.startCheckout(input);
    return c.json(toWireCheckout(checkout), 201);
  });

  // GET /checkouts/:id
  router.get("/checkouts/:id", async (c) => {
    const checkout = await service.getCheckout(c.req.param("id"));
    if (!checkout) throw new NotFoundError("Checkout not found.");
    return c.json(toWireCheckout(checkout));
  });

  // PUT /checkouts/:id/addresses
  router.put("/checkouts/:id/addresses", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(setAddressesSchema, raw);
    const checkout = await service.setAddresses(c.req.param("id"), input);
    return c.json(toWireCheckout(checkout));
  });

  // PUT /checkouts/:id/shipping
  router.put("/checkouts/:id/shipping", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(setShippingSchema, raw);
    const checkout = await service.setShipping(c.req.param("id"), input);
    return c.json(toWireCheckout(checkout));
  });

  // POST /checkouts/:id/complete — guarded by Idempotency-Key
  router.post(
    "/checkouts/:id/complete",
    requireIdempotencyKey({ scope: "checkout.complete" }),
    async (c) => {
      const raw = await readJsonBody(c.req.raw);
      const input = parseOrThrow(completeCheckoutSchema, raw);
      const idempotencyKey =
        c.req.header("idempotency-key") ??
        c.req.header("Idempotency-Key") ??
        null;
      const result = await service.complete(c.req.param("id"), {
        paymentMethod: input.paymentMethod,
        idempotencyKey,
      });
      return c.json({
        checkout: toWireCheckout(result.checkout),
        orderIntent: toWireOrderIntent(result.orderIntent),
      });
    },
  );

  // POST /checkouts/:id/cancel
  router.post("/checkouts/:id/cancel", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    // The cancel body is fully optional. `cancelCheckoutSchema` is itself
    // optional() at the top level so missing/empty is allowed.
    const input = parseOrThrow(cancelCheckoutSchema, raw ?? {});
    const checkout = await service.cancel(c.req.param("id"), {
      reason: input?.reason ?? null,
    });
    return c.json(toWireCheckout(checkout));
  });

  return router;
}
