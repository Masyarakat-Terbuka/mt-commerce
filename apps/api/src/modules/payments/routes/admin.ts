/**
 * Admin payments routes — staff-facing list/detail + capture/refund.
 *
 * Mounted at `/admin/v1` from the top-level router. Auth gating mirrors
 * the catalog/orders admin routers: every route requires a session-
 * authenticated staff user; the role gate accepts `owner | admin |
 * staff` (viewer is excluded for parity).
 *
 * Mutating endpoints (`/capture`, `/refund`) carry the
 * `requireIdempotencyKey` middleware. The HTTP-layer middleware dedupes
 * the request/response body; the service-level idempotency on the
 * `payments.idempotency_key` column applies only to the storefront's
 * `initiate` (the admin actions target an existing payment row).
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { NotFoundError } from "../../../lib/errors.js";
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
import { getAuthedUser, requireAuth, requireRole } from "../../auth/index.js";
import type { PaymentService } from "../service.js";
import {
  capturePaymentSchema,
  listPaymentsQuerySchema,
  refundPaymentSchema,
} from "../types.js";
import { toWirePayment, toWirePaymentWithAttempts } from "./wire.js";
import {
  PaginatedPaymentWire,
  PaymentWire,
  PaymentWithAttemptsWire,
} from "./openapi-schemas.js";

const TAG = "payments (admin)";

const IdParam = z.object({ id: z.string().min(1) });

export interface BuildPaymentsAdminOptions {
  /** Test seam — inject a fake idempotency store. Production callers omit this. */
  idempotencyStore?: IdempotencyStore;
}

export function buildPaymentsAdminRoutes(
  service: PaymentService,
  options: BuildPaymentsAdminOptions = {},
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  const requireIdempotencyKey = options.idempotencyStore
    ? buildIdempotencyKeyTestMiddleware(options.idempotencyStore)
    : defaultRequireIdempotencyKey;

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.openapi(
    createRoute({
      method: "get",
      path: "/payments",
      tags: [TAG],
      summary: "List payments",
      description:
        "Paginated list. Filter by orderId, status, and provider code.",
      request: { query: listPaymentsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedPaymentWire } },
          description: "Page of payments.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.list(query);
      return c.json(
        {
          data: result.data.map(toWirePayment),
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
      path: "/payments/{id}",
      tags: [TAG],
      summary: "Get a payment with its attempt history",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: PaymentWithAttemptsWire } },
          description: "Payment with full attempt history.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const payment = await service.getById(c.req.param("id"));
      if (!payment) throw new NotFoundError("Payment not found.");
      return c.json(toWirePaymentWithAttempts(payment), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/payments/{id}/capture",
      tags: [TAG],
      summary: "Capture an authorised payment",
      description:
        "Idempotent: requires an `Idempotency-Key` header. Replays return the same response.",
      middleware: [requireIdempotencyKey({ scope: "payment.capture" })],
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: capturePaymentSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: PaymentWire } },
          description: "Captured payment.",
        },
        400: errorResponse("Validation failed or missing Idempotency-Key."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Payment not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      // Cast required: per-route `middleware: [...]` narrows the
      // context's bindings to `never`. The router-level `requireAuth`
      // still runs first and populates `authUser`; `getAuthedUser`
      // simply re-asserts non-null, so the cast is a typing fix, not
      // a security relaxation.
      const user = getAuthedUser(c as unknown as Context<AppBindings>);
      const updated = await service.capture({
        paymentId: c.req.param("id"),
        ...(input.amount !== undefined ? { amount: BigInt(input.amount) } : {}),
        actorId: user.id,
      });
      return c.json(toWirePayment(updated), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/payments/{id}/refund",
      tags: [TAG],
      summary: "Refund a captured payment",
      description:
        "Idempotent: requires an `Idempotency-Key` header. Body accepts an optional `amount` (partial refund) and `reason`.",
      middleware: [requireIdempotencyKey({ scope: "payment.refund" })],
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: refundPaymentSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: PaymentWire } },
          description: "Refunded payment.",
        },
        400: errorResponse("Validation failed or missing Idempotency-Key."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Payment not found."),
        409: errorResponse("Invalid state transition."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      // Cast required: per-route `middleware: [...]` narrows the
      // context's bindings to `never`. The router-level `requireAuth`
      // still runs first and populates `authUser`; `getAuthedUser`
      // simply re-asserts non-null, so the cast is a typing fix, not
      // a security relaxation.
      const user = getAuthedUser(c as unknown as Context<AppBindings>);
      const updated = await service.refund({
        paymentId: c.req.param("id"),
        ...(input.amount !== undefined ? { amount: BigInt(input.amount) } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        actorId: user.id,
      });
      return c.json(toWirePayment(updated), 200);
    },
  );

  return router;
}
