/**
 * Storefront payments routes — buyer-facing initiate + read.
 *
 * Mounted at `/storefront/v1` from the top-level router. Bearer pattern
 * matches checkout: anyone with a checkout id can initiate a payment
 * for the order it produced. Cross-customer protection rests on the
 * unguessable ULID of the checkout id (same model the cart uses).
 *
 * `initiate` carries the `requireIdempotencyKey` middleware. The
 * caller's `Idempotency-Key` header is also passed through to the
 * service as the business-level dedupe handle on the `payments`
 * row — see `payments.idempotency_key`. A retry with the same key
 * returns the existing payment instead of starting a second charge.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError } from "../../../lib/errors.js";
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
import {
  orderService as defaultOrderService,
  type OrderService,
} from "../../orders/index.js";
import type { PaymentService } from "../service.js";
import { initiatePaymentSchema } from "../types.js";
import {
  toWireInitiateOutcome,
  toWirePayment,
} from "./wire.js";
import {
  PaymentInitiateOutcomeWire,
  PaymentWire,
} from "./openapi-schemas.js";

const TAG = "payments (storefront)";

const CheckoutIdParam = z.object({ id: z.string().min(1) });

export interface BuildPaymentsStorefrontOptions {
  /** Override the default OrderService — tests inject a fake. */
  orderService?: OrderService;
  /** Test seam — inject a fake idempotency store. */
  idempotencyStore?: IdempotencyStore;
}

export function buildPaymentsStorefrontRoutes(
  service: PaymentService,
  options: BuildPaymentsStorefrontOptions = {},
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  const orders = options.orderService ?? defaultOrderService;
  const requireIdempotencyKey = options.idempotencyStore
    ? buildIdempotencyKeyTestMiddleware(options.idempotencyStore)
    : defaultRequireIdempotencyKey;

  router.openapi(
    createRoute({
      method: "post",
      path: "/checkouts/{id}/payment/initiate",
      tags: [TAG],
      summary: "Initiate payment for a completed checkout",
      description:
        "Requires an `Idempotency-Key` header — the same key dedupes the underlying `payments` row, so a retry returns the same outcome instead of charging twice.",
      middleware: [requireIdempotencyKey({ scope: "payment.initiate" })],
      request: {
        params: CheckoutIdParam,
        body: {
          content: { "application/json": { schema: initiatePaymentSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: PaymentInitiateOutcomeWire } },
          description: "Payment outcome — redirect, captured, or pending.",
        },
        400: errorResponse("Validation failed or missing Idempotency-Key."),
        404: errorResponse("Checkout has no associated order yet."),
        409: errorResponse("Order is not in a payable state, or provider is unknown."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const checkoutId = c.req.param("id");
      const idempotencyKey =
        c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
      if (!idempotencyKey) {
        // The middleware enforces this already; the redundant guard
        // narrows the type for the service call.
        throw new ConflictError("Idempotency-Key header is required.", {
          code: "idempotency_key_required",
        });
      }

      const order = await orders.getOrderByCheckoutId(checkoutId);
      if (!order) {
        throw new NotFoundError(
          "No order has been created for this checkout yet.",
          { checkoutId },
        );
      }

      const outcome = await service.initiate({
        orderId: order.id,
        providerCode: input.providerCode,
        idempotencyKey,
        customer: {
          id: order.customerId,
          email: order.email,
          phone: null,
          name: null,
        },
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
      return c.json(toWireInitiateOutcome(outcome), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/checkouts/{id}/payment",
      tags: [TAG],
      summary: "Get the payment for this checkout",
      description:
        "Returns the payment row attached to the order this checkout produced. 404 when no payment has been initiated yet.",
      request: { params: CheckoutIdParam },
      responses: {
        200: {
          content: { "application/json": { schema: PaymentWire } },
          description: "Payment.",
        },
        404: errorResponse("No payment for this checkout."),
      },
    }),
    async (c) => {
      const checkoutId = c.req.param("id");
      const order = await orders.getOrderByCheckoutId(checkoutId);
      if (!order) {
        throw new NotFoundError(
          "No order has been created for this checkout yet.",
          { checkoutId },
        );
      }
      const payment = await service.getByOrderId(order.id);
      if (!payment) {
        throw new NotFoundError("No payment for this checkout.", { checkoutId });
      }
      return c.json(toWirePayment(payment), 200);
    },
  );

  return router;
}
