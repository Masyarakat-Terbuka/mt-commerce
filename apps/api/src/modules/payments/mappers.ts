/**
 * Drizzle row → payments domain type mappers.
 *
 * Same collapse pattern as the orders module:
 *   - the `(amount, currency)` pair on `payments` becomes a single
 *     `Money` value object,
 *   - `jsonb` columns are narrowed back to `Record<string, unknown>` —
 *     the application is the sole writer and always emits the canonical
 *     shape,
 *   - the `status` text column is asserted into the `PaymentStatus`
 *     union; a future enum tightening would catch drift in tests.
 */
import type {
  PaymentAttemptRow,
  PaymentRow,
} from "../../db/schema/index.js";
import type {
  Payment,
  PaymentAttempt,
  PaymentAttemptKind,
  PaymentAttemptStatus,
  PaymentStatus,
} from "./types.js";

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.orderId,
    provider: row.provider,
    providerRef: row.providerRef ?? null,
    amount: { amount: row.amount, currency: row.currency },
    status: row.status as PaymentStatus,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPaymentAttempt(row: PaymentAttemptRow): PaymentAttempt {
  return {
    id: row.id,
    paymentId: row.paymentId,
    kind: row.kind as PaymentAttemptKind,
    status: row.status as PaymentAttemptStatus,
    requestPayload: (row.requestPayload ?? {}) as Record<string, unknown>,
    responsePayload: row.responsePayload
      ? (row.responsePayload as Record<string, unknown>)
      : null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
  };
}
