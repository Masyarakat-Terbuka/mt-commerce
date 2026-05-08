/**
 * Shared OpenAPI wire-shape schemas for the payments routes.
 *
 * Both the admin and storefront (and webhook) routers reference the
 * same JSON shape for payments and payment attempts, so we register
 * each component once.
 */
import { z } from "@hono/zod-openapi";
import { MoneyJson, paginated } from "../../../lib/openapi-shared.js";

const PaymentStatusEnum = z.enum([
  "pending",
  "authorized",
  "captured",
  "failed",
  "refunded",
  "cancelled",
]);

const PaymentAttemptKindEnum = z.enum([
  "initiate",
  "capture",
  "refund",
  "webhook",
]);

const PaymentAttemptStatusEnum = z.enum(["pending", "success", "failure"]);

export const PaymentWire = z
  .object({
    id: z.string(),
    orderId: z.string(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    amount: MoneyJson,
    status: PaymentStatusEnum,
    idempotencyKey: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Payment");

export const PaymentAttemptWire = z
  .object({
    id: z.string(),
    paymentId: z.string(),
    kind: PaymentAttemptKindEnum,
    status: PaymentAttemptStatusEnum,
    requestPayload: z.record(z.string(), z.unknown()),
    responsePayload: z.record(z.string(), z.unknown()).nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("PaymentAttempt");

export const PaymentWithAttemptsWire = z
  .object({
    id: z.string(),
    orderId: z.string(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    amount: MoneyJson,
    status: PaymentStatusEnum,
    idempotencyKey: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    attempts: z.array(PaymentAttemptWire),
  })
  .openapi("PaymentWithAttempts");

export const PaginatedPaymentWire = paginated(PaymentWire).openapi(
  "PaginatedPayment",
);

/**
 * Storefront `initiate` outcome. Discriminated by `status` — the
 * route layer narrows on the variant. `redirectUrl` is present only on
 * the redirect variant.
 */
export const PaymentInitiateOutcomeWire = z
  .object({
    status: z.enum(["redirect", "captured", "pending"]),
    paymentId: z.string(),
    redirectUrl: z.string().url().optional(),
  })
  .openapi("PaymentInitiateOutcome");

/** Webhook ingress response — small envelope, never carries the payload back. */
export const WebhookAckWire = z
  .object({
    status: z.enum(["accepted", "ignored"]),
    paymentId: z.string().nullable(),
    event: z.string().nullable(),
  })
  .openapi("WebhookAck");
