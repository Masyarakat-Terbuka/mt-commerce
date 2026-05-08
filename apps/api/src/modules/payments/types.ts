/**
 * Payments module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the orders module:
 *
 *   1. Domain types (`Payment`, `PaymentAttempt`, `PaymentStatus`,
 *      `PaymentInitiateOutcome`, `Paginated<T>`) — clean shapes the rest
 *      of the system consumes. Money is a `Money` value object; dates
 *      are `Date` instances; the route layer converts to ISO strings on
 *      the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for
 *      request shape; surfaced through the standard validation_error
 *      envelope.
 */
import { z } from "zod";
import type { Money } from "@mt-commerce/core/money";
import {
  ALL_PAYMENT_ATTEMPT_KINDS,
  ALL_PAYMENT_ATTEMPT_STATUSES,
  ALL_PAYMENT_STATUSES,
  type PaymentAttemptKind,
  type PaymentAttemptStatus,
  type PaymentStatus,
} from "./state.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type { PaymentAttemptKind, PaymentAttemptStatus, PaymentStatus };

export interface Payment {
  id: string;
  orderId: string;
  /** Provider code (e.g. `in_memory_test`, `midtrans`). */
  provider: string;
  /** Provider's id once the first call settles. Null before then. */
  providerRef: string | null;
  amount: Money;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentAttempt {
  id: string;
  paymentId: string;
  kind: PaymentAttemptKind;
  status: PaymentAttemptStatus;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: Date;
}

/**
 * Detail view returned by `GET /admin/v1/payments/{id}` — the canonical
 * payment row with its attempt history attached.
 */
export interface PaymentWithAttempts extends Payment {
  attempts: PaymentAttempt[];
}

/**
 * Service-level outcome of `initiate`. Mirrors `InitiateResult` from
 * the provider seam but carries the `paymentId` (and the redirect URL
 * when applicable) so the storefront can drive the next step.
 */
export type PaymentInitiateOutcome =
  | { status: "redirect"; paymentId: string; redirectUrl: string }
  | { status: "captured"; paymentId: string }
  | { status: "pending"; paymentId: string };

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const paymentStatusSchema = z.enum(
  ALL_PAYMENT_STATUSES as readonly [PaymentStatus, ...PaymentStatus[]],
);

const _paymentAttemptKindSchema = z.enum(
  ALL_PAYMENT_ATTEMPT_KINDS as readonly [PaymentAttemptKind, ...PaymentAttemptKind[]],
);

const _paymentAttemptStatusSchema = z.enum(
  ALL_PAYMENT_ATTEMPT_STATUSES as readonly [
    PaymentAttemptStatus,
    ...PaymentAttemptStatus[],
  ],
);

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Storefront `initiate`. The body is just the provider code — the
 * checkout id (URL param) and the order it produced (resolved
 * server-side) supply the rest. The HTTP-layer `Idempotency-Key`
 * middleware dedupes the request; the service uses that header value
 * as the business-level idempotency key on the `payments` row.
 */
export const initiatePaymentSchema = z.object({
  providerCode: z.string().min(1).max(64),
  /** Free-form provider hints (test codes, plugin-specific options). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;

/**
 * Admin `capture` — body is empty in v0.1 (full capture). A future
 * `amount` field can be added without a breaking change.
 */
export const capturePaymentSchema = z
  .object({
    /** Optional partial-capture amount (decimal string). */
    amount: z
      .string()
      .regex(/^\d+$/, { message: "amount must be a non-negative integer string" })
      .optional(),
  })
  .strict();
export type CapturePaymentInput = z.infer<typeof capturePaymentSchema>;

/**
 * Admin `refund` — optional `amount` for partial refunds, optional
 * `reason` for the audit trail.
 */
export const refundPaymentSchema = z
  .object({
    amount: z
      .string()
      .regex(/^\d+$/, { message: "amount must be a non-negative integer string" })
      .optional(),
    reason: z
      .string()
      .max(500)
      .optional()
      .transform((value) => {
        if (value === undefined) return undefined;
        const trimmed = value.trim();
        return trimmed.length === 0 ? undefined : trimmed;
      }),
  })
  .strict();
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listPaymentsQuerySchema = z.object({
  orderId: z.string().min(1).max(100).optional(),
  status: paymentStatusSchema.optional(),
  provider: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export {
  _paymentAttemptKindSchema as paymentAttemptKindSchema,
  _paymentAttemptStatusSchema as paymentAttemptStatusSchema,
  paymentStatusSchema,
};
