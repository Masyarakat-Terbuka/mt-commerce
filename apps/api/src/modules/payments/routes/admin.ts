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

  // -------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------

  const ReconcileResultWire = z
    .object({
      kind: z.enum([
        "applied",
        "no_change",
        "still_pending",
        "unknown_to_provider",
        "provider_unsupported",
        "terminal",
        "error",
      ]),
      paymentId: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      current: z.string().optional(),
      provider: z.string().optional(),
      message: z.string().optional(),
    })
    .openapi("PaymentReconcileResult");

  const ReconcilePendingResultWire = z
    .object({
      checked: z.number().int().nonnegative(),
      applied: z.number().int().nonnegative(),
      noChange: z.number().int().nonnegative(),
      stillPending: z.number().int().nonnegative(),
      unknownToProvider: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
    })
    .openapi("PaymentReconcilePendingResult");

  const ReconcilePendingBody = z
    .object({
      olderThanMinutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24)
        .optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .openapi("PaymentReconcilePendingInput");

  router.openapi(
    createRoute({
      method: "post",
      path: "/payments/{id}/reconcile",
      tags: [TAG],
      summary: "Reconcile a single payment with the provider",
      description:
        "Asks the registered provider for the canonical status of this payment. If the provider reports a terminal status the platform has not yet seen, the row is transitioned and the linked order follows. Used to recover from missed webhooks.",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: ReconcileResultWire } },
          description: "Reconciliation outcome.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Payment not found."),
      },
    }),
    async (c) => {
      const result = await service.reconcilePayment(c.req.param("id"));
      return c.json(result, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/payments/reconcile-pending",
      tags: [TAG],
      summary: "Reconcile every pending payment older than a threshold",
      description:
        "Bulk reconciliation. Loads non-terminal payments whose `updated_at` is older than `olderThanMinutes` (default 5), polls each provider, and applies the canonical status. Designed to run from a host cron (or a job queue) every few minutes.",
      request: {
        body: {
          required: false,
          content: { "application/json": { schema: ReconcilePendingBody } },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: ReconcilePendingResultWire },
          },
          description: "Aggregate counts across the reconciled candidates.",
        },
        400: errorResponse("Invalid body."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      // The body is optional — when absent, the service uses defaults.
      let body: { olderThanMinutes?: number; limit?: number } = {};
      try {
        const parsed = c.req.valid("json");
        if (parsed) body = parsed;
      } catch {
        // No body / invalid JSON. Fall back to defaults; the schema is
        // permissive so this is the friendly path.
      }
      const result = await service.reconcilePendingPayments(body);
      return c.json(result, 200);
    },
  );

  return router;
}
