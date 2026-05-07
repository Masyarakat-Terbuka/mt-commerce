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
 *
 * OpenAPI: each route is declared via `createRoute`/`router.openapi(...)`.
 * The cancel endpoint reads the raw body directly because its body schema
 * is fully optional (so the OpenAPI body wrapper would force a content
 * type even on the no-body call); manual parsing keeps the documented
 * behavior identical.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ValidationError } from "../../../lib/errors.js";
import { NotFoundError } from "../../../lib/errors.js";
import { issuesToDetails } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
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
import { toWireCheckout, toWireOrderIntent } from "./wire.js";
import {
  CheckoutWire,
  CompleteCheckoutResponseWire,
} from "./openapi-schemas.js";

const TAG = "checkout (storefront)";

const IdParam = z.object({ id: z.string().min(1) });

export interface BuildCheckoutStorefrontOptions {
  /**
   * Test seam — inject a fake idempotency store so route-level tests do
   * not need a real database. Production callers omit this.
   */
  idempotencyStore?: IdempotencyStore;
}

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }
}

export function buildCheckoutStorefrontRoutes(
  service: CheckoutService,
  options: BuildCheckoutStorefrontOptions = {},
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  const requireIdempotencyKey = options.idempotencyStore
    ? buildIdempotencyKeyTestMiddleware(options.idempotencyStore)
    : defaultRequireIdempotencyKey;

  router.openapi(
    createRoute({
      method: "post",
      path: "/checkouts",
      tags: [TAG],
      summary: "Start a checkout from a cart",
      request: {
        body: {
          content: { "application/json": { schema: startCheckoutSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: CheckoutWire } },
          description: "Created checkout.",
        },
        400: errorResponse("Validation failed."),
        404: errorResponse("Cart not found."),
        409: errorResponse("Cart is not in a startable state."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const checkout = await service.startCheckout(input);
      return c.json(toWireCheckout(checkout), 201);
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
      method: "put",
      path: "/checkouts/{id}/addresses",
      tags: [TAG],
      summary: "Set the shipping (and optional billing) address",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: setAddressesSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CheckoutWire } },
          description: "Updated checkout.",
        },
        400: errorResponse("Validation failed."),
        404: errorResponse("Checkout or address not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const checkout = await service.setAddresses(c.req.param("id"), input);
      return c.json(toWireCheckout(checkout), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/checkouts/{id}/shipping",
      tags: [TAG],
      summary: "Select shipping method and rate",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: setShippingSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CheckoutWire } },
          description: "Updated checkout.",
        },
        400: errorResponse("Validation failed."),
        404: errorResponse("Checkout not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const checkout = await service.setShipping(c.req.param("id"), input);
      return c.json(toWireCheckout(checkout), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/checkouts/{id}/complete",
      tags: [TAG],
      summary: "Complete a checkout (idempotent)",
      description:
        "Idempotent: requires an `Idempotency-Key` header. Replays return the same response without re-running the underlying transition.",
      middleware: [requireIdempotencyKey({ scope: "checkout.complete" })],
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: completeCheckoutSchema } },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: CompleteCheckoutResponseWire },
          },
          description: "Checkout completed; order intent attached.",
        },
        400: errorResponse("Validation failed or missing Idempotency-Key."),
        404: errorResponse("Checkout not found."),
        409: errorResponse("Invalid state transition or idempotency conflict."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const idempotencyKey =
        c.req.header("idempotency-key") ??
        c.req.header("Idempotency-Key") ??
        null;
      const result = await service.complete(c.req.param("id"), {
        paymentMethod: input.paymentMethod,
        idempotencyKey,
      });
      return c.json(
        {
          checkout: toWireCheckout(result.checkout),
          orderIntent: toWireOrderIntent(result.orderIntent),
        },
        200,
      );
    },
  );

  // Cancel: the body schema is wrapped in `.optional()` so the route accepts
  // a no-body POST. We do not declare `body` in the OpenAPI request descriptor
  // because that would imply a required content-type; instead we read the
  // raw body and parse manually, preserving the existing public contract.
  router.openapi(
    createRoute({
      method: "post",
      path: "/checkouts/{id}/cancel",
      tags: [TAG],
      summary: "Cancel a checkout",
      description:
        "Optional body: `{ reason?: string | null }`. Cancellation is allowed from any non-terminal state and yields `state=failed`.",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CheckoutWire } },
          description: "Cancelled checkout.",
        },
        404: errorResponse("Checkout not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const raw = await readJsonBody(c.req.raw);
      const parsed = cancelCheckoutSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        throw new ValidationError(
          "Request validation failed.",
          issuesToDetails(parsed.error.issues),
        );
      }
      const checkout = await service.cancel(c.req.param("id"), {
        reason: parsed.data?.reason ?? null,
      });
      return c.json(toWireCheckout(checkout), 200);
    },
  );

  return router;
}
