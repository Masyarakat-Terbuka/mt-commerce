/**
 * Wire-shape helpers — convert payments domain types to JSON-safe payloads.
 *
 * Same rationale as the orders/checkout wire layers:
 *   - `Date` → ISO 8601 string
 *   - `Money` → `MoneyJSON` ({ amount: "<decimal>", currency }) per ADR-0007
 *   - Optional fields render as `null`, never absent
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Payment,
  PaymentAttempt,
  PaymentInitiateOutcome,
  PaymentWithAttempts,
} from "../types.js";

export interface WirePayment {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string | null;
  amount: MoneyJSON;
  status: Payment["status"];
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface WirePaymentAttempt {
  id: string;
  paymentId: string;
  kind: PaymentAttempt["kind"];
  status: PaymentAttempt["status"];
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface WirePaymentWithAttempts extends WirePayment {
  attempts: WirePaymentAttempt[];
}

export interface WirePaymentInitiateOutcome {
  status: "redirect" | "captured" | "pending";
  paymentId: string;
  redirectUrl?: string;
}

export function toWirePayment(payment: Payment): WirePayment {
  return {
    id: payment.id,
    orderId: payment.orderId,
    provider: payment.provider,
    providerRef: payment.providerRef,
    amount: moneyToJSON(payment.amount),
    status: payment.status,
    idempotencyKey: payment.idempotencyKey,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

export function toWirePaymentAttempt(
  attempt: PaymentAttempt,
): WirePaymentAttempt {
  return {
    id: attempt.id,
    paymentId: attempt.paymentId,
    kind: attempt.kind,
    status: attempt.status,
    requestPayload: attempt.requestPayload,
    responsePayload: attempt.responsePayload,
    errorMessage: attempt.errorMessage,
    createdAt: attempt.createdAt.toISOString(),
  };
}

export function toWirePaymentWithAttempts(
  payment: PaymentWithAttempts,
): WirePaymentWithAttempts {
  return {
    ...toWirePayment(payment),
    attempts: payment.attempts.map(toWirePaymentAttempt),
  };
}

export function toWireInitiateOutcome(
  outcome: PaymentInitiateOutcome,
): WirePaymentInitiateOutcome {
  switch (outcome.status) {
    case "redirect":
      return {
        status: "redirect",
        paymentId: outcome.paymentId,
        redirectUrl: outcome.redirectUrl,
      };
    case "captured":
      return { status: "captured", paymentId: outcome.paymentId };
    case "pending":
      return { status: "pending", paymentId: outcome.paymentId };
  }
}
