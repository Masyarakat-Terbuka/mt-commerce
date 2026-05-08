/**
 * Payments — one canonical row per order, plus an append-only attempts log.
 *
 * Per ADR-0007 every money column is `bigint` in the smallest unit of
 * `currency`. Per PRODUCT.md ("conservative where money is involved",
 * "honest about money", "payment operations are idempotent") these tables
 * are the system of record for "did we charge the buyer, did the provider
 * accept, did the webhook arrive."
 *
 * Modeling decisions:
 *
 *   - `provider` is plain `text` (not a `pgEnum`). Plugins ship new
 *     provider codes (`midtrans`, `xendit`, `stripe`, ...) without
 *     requiring a schema migration; the application narrows to known
 *     codes via the registry. The `in_memory_test` code is the default
 *     test/dev provider; production deployments add real providers via
 *     plugin `register(provider)` calls.
 *
 *   - `provider_ref` is nullable because we write the `payments` row
 *     before calling the provider (so an idempotent retry on the same
 *     `idempotency_key` returns the existing row even if the first
 *     provider call failed). Once the provider responds we patch
 *     `provider_ref` with the provider's own id (Midtrans `transaction_id`,
 *     Stripe `pi_...`, etc.). Reads by `provider_ref` (the webhook
 *     dispatch path) only consider non-null values.
 *
 *   - `idempotency_key` is UNIQUE — a caller-supplied key dedupes
 *     `initiate` calls. It is NOT the same as the HTTP-layer
 *     `Idempotency-Key` middleware (`idempotency_keys` table); the HTTP
 *     middleware dedupes the request/response, this column dedupes the
 *     business-level "I want to start a payment for this order with this
 *     attempt-id." A retry with the same key returns the existing
 *     payment row instead of double-charging.
 *
 *   - `status` lives in `text` for parity with `orders.status` /
 *     `cart.status`. Allowed values:
 *       `pending | authorized | captured | failed | refunded | cancelled`
 *     The application narrows the union via `state.ts`.
 *
 *   - `payment_attempts` rows are append-only. Every call we make to the
 *     provider — `initiate`, `capture`, `refund`, plus inbound `webhook`
 *     events — writes a row. Reading the table top-to-bottom for a
 *     payment id reconstructs the lifecycle even when the provider's own
 *     dashboard is unavailable. The request/response payloads are stored
 *     verbatim (`jsonb`) so a future incident review can replay the call
 *     against a sandbox.
 *
 * Indexing strategy:
 *   - `payments(order_id)`              — "show me the payment for this order"
 *     (the storefront's `GET /checkouts/:id/payment` resolves through the
 *     order id).
 *   - `payments(provider, provider_ref)` (partial, NOT NULL) — webhook
 *     dispatch resolves a provider event to a payment via this lookup.
 *   - unique `payments(idempotency_key)` — dedupe the initiate path.
 *   - `payment_attempts(payment_id, created_at DESC)` — the audit-trail
 *     read pattern is "events for this payment, newest first."
 */
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { orders } from "./orders.js";

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    /**
     * One payment per order in v0.1. A future "split payments"
     * iteration would relax this to many-to-one and lift the
     * `payments_order_id_idx` to a full lookup index.
     */
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /**
     * Plugin-extensible provider code. Examples: `in_memory_test`,
     * `midtrans`, `xendit`. The registry resolves the code at runtime —
     * the column carries no FK because providers are application-level,
     * not a database table.
     */
    provider: text("provider").notNull(),
    /**
     * Provider's own id for this payment (Midtrans `transaction_id`,
     * Stripe `pi_...`). NULL until the provider's `initiate` settles;
     * webhook dispatch ignores rows where this is NULL.
     */
    providerRef: text("provider_ref"),
    /** ISO 4217 — must match the parent order's currency. */
    currency: text("currency").notNull(),
    /** Total to charge in the smallest unit of `currency`. */
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    /**
     * Lifecycle status. Allowed values:
     *   `pending | authorized | captured | failed | refunded | cancelled`.
     * Validated at the application boundary via `state.ts`.
     */
    status: text("status").notNull().default("pending"),
    /**
     * Caller-supplied dedupe handle for the `initiate` call. Two calls
     * with the same key return the same row instead of starting a second
     * provider charge.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderIdx: index("payments_order_id_idx").on(table.orderId),
    providerRefIdx: index("payments_provider_ref_idx").on(
      table.provider,
      table.providerRef,
    ),
    idempotencyKeyUnique: unique("payments_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
  }),
);

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    /**
     * One of `initiate | capture | refund | webhook`. Plain text rather
     * than `pgEnum` so a future plugin can add a new kind (e.g.
     * `void`, `authorize`) without a migration.
     */
    kind: text("kind").notNull(),
    /** `pending | success | failure` — outcome of the provider call. */
    status: text("status").notNull(),
    /** What we sent to the provider (or what the webhook delivered). */
    requestPayload: jsonb("request_payload").notNull().default({}),
    /** Provider's response, if any. NULL on a thrown adapter call. */
    responsePayload: jsonb("response_payload"),
    /** Set when `status = failure`. Free-text from the adapter. */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    paymentCreatedIdx: index("payment_attempts_payment_created_idx").on(
      table.paymentId,
      table.createdAt,
    ),
  }),
);

export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttemptRow = typeof paymentAttempts.$inferInsert;
