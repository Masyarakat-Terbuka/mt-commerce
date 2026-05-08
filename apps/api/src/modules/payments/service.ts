/**
 * `PaymentService` — public contract for the payments module.
 *
 * Owns:
 *
 *   - The `payments` row lifecycle: `initiate` writes (or rehydrates
 *     by `idempotencyKey`) the row, calls the provider, persists the
 *     outcome, and emits `payment.initiated` (and `payment.captured`
 *     when the provider settled synchronously). Capture-on-initiate
 *     drives the order `pending_payment → paid` immediately.
 *
 *   - Manual `capture`: for providers that authorise-then-capture, the
 *     admin invokes `capture` to settle the charge. Records an attempt
 *     row, transitions the payment `pending|authorized → captured`,
 *     and drives the order `pending_payment → paid`. Emits
 *     `payment.captured`.
 *
 *   - `refund`: full or partial. Records the attempt, transitions the
 *     payment `captured → refunded`, drives the order to `refunded`.
 *     Emits `payment.refunded`. Per ADR-0007 every money column is
 *     `bigint`; partial-refund amounts are recorded on the attempt's
 *     `requestPayload` (the parent `payments` row tracks status, not
 *     a partial amount, in v0.1).
 *
 *   - `handleWebhook`: provider.verifyWebhookSignature → look up the
 *     payment by `(providerCode, providerRef)` → transition the
 *     payment + order accordingly → record the webhook attempt.
 *     Idempotent on repeated delivery: a second `captured` event for
 *     an already-`captured` payment writes a fresh attempt row but
 *     does NOT re-transition (and does NOT re-trigger the order
 *     transition, which would 409 anyway).
 *
 *   - Read paths: `getById` (with attempt history), `getByOrderId`,
 *     `list` for the admin grid.
 *
 * Provider resolution flows through the registry, NOT a constructor
 * injection: the plugin loader installs new providers at startup and
 * the service resolves at call time. A row referencing a code whose
 * plugin has been removed surfaces as a clean
 * `ConflictError {code:"unknown_provider"}` rather than a deep crash.
 */
import {
  type Money,
} from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import {
  auditService as defaultAuditService,
  type AuditService,
} from "../audit/index.js";
import {
  orderService as defaultOrderService,
  type OrderService,
} from "../orders/index.js";
import { events, type EventName, type EventPayload } from "./events.js";
import { toPayment, toPaymentAttempt } from "./mappers.js";
import {
  createPaymentsRepository,
  type PaymentsRepository,
} from "./repository.js";
import {
  paymentProviderRegistry as defaultRegistry,
  type PaymentProviderRegistry,
} from "./providers/registry.js";
import type {
  InitiateResult,
  PaymentProvider,
  VerifiedWebhook,
} from "./providers/types.js";
import {
  ALL_PAYMENT_STATUSES,
  canTransition,
  isTerminal,
  type PaymentStatus,
} from "./state.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListPaymentsQuery,
  type Paginated,
  type Payment,
  type PaymentAttempt,
  type PaymentInitiateOutcome,
  type PaymentWithAttempts,
} from "./types.js";

const log = childLogger("payments");

export interface InitiatePaymentInput {
  orderId: string;
  providerCode: string;
  /**
   * Caller-supplied dedupe handle. The HTTP routes pass through the
   * `Idempotency-Key` header verbatim — the column is unique, so a
   * second call with the same key returns the existing row instead of
   * starting a second provider charge.
   */
  idempotencyKey: string;
  customer: {
    id: string | null;
    email: string;
    phone: string | null;
    name: string | null;
  };
  metadata?: Record<string, unknown>;
}

export interface CapturePaymentInput {
  paymentId: string;
  /** Optional partial-capture amount (smallest currency unit). */
  amount?: bigint;
  /** Staff user id when invoked via the admin route. */
  actorId?: string | null;
}

export interface RefundPaymentInput {
  paymentId: string;
  /** Optional partial-refund amount (smallest currency unit). */
  amount?: bigint;
  reason?: string | null;
  actorId?: string | null;
}

export interface HandleWebhookInput {
  providerCode: string;
  rawBody: string;
  /** Headers MUST be lower-cased before passing in. */
  headers: Record<string, string>;
}

export interface HandleWebhookResult {
  /** `accepted` when the event was applied; `ignored` when the payment is unknown or already terminal. */
  status: "accepted" | "ignored";
  paymentId: string | null;
  /** Provider event name, kept verbatim. Useful for the audit log on the receiving side. */
  event: string | null;
}

export interface PaymentService {
  initiate(input: InitiatePaymentInput): Promise<PaymentInitiateOutcome>;
  capture(input: CapturePaymentInput): Promise<Payment>;
  refund(input: RefundPaymentInput): Promise<Payment>;
  getById(paymentId: string): Promise<PaymentWithAttempts | null>;
  getByOrderId(orderId: string): Promise<Payment | null>;
  list(query: ListPaymentsQuery): Promise<Paginated<Payment>>;
  listAttempts(paymentId: string): Promise<PaymentAttempt[]>;
  handleWebhook(input: HandleWebhookInput): Promise<HandleWebhookResult>;
}

/**
 * Captured event to fire AFTER the enclosing transaction commits. Same
 * shape as the orders/checkout module's PendingEvent.
 */
type PendingEvent = {
  [E in EventName]: { name: E; payload: EventPayload<E> };
}[EventName];

export class PaymentServiceImpl implements PaymentService {
  constructor(
    private readonly repo: PaymentsRepository,
    private readonly orders: OrderService = defaultOrderService,
    private readonly registry: PaymentProviderRegistry = defaultRegistry,
    private readonly audits: AuditService = defaultAuditService,
  ) {}

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async initiate(input: InitiatePaymentInput): Promise<PaymentInitiateOutcome> {
    if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
      // The route layer enforces this via the middleware, but a service
      // caller (e.g. a future plugin) might not — fail loud rather than
      // writing a row with an empty key.
      throw new ValidationError(
        "An idempotencyKey is required to initiate a payment.",
        { code: "idempotency_key_required" },
      );
    }

    // Resolve the provider FIRST — a typo on `providerCode` should not
    // result in a half-written row.
    const provider = this.resolveProvider(input.providerCode);

    // Idempotent rehydrate: a retry with the same business-level key
    // returns the existing row's outcome instead of charging again.
    const existing = await this.repo.getPaymentByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      // Defensive: the `(idempotencyKey)` unique guarantees row
      // identity, but if the caller reused the key against a different
      // order they meant a different intent — surface the conflict.
      if (existing.orderId !== input.orderId) {
        throw new ConflictError(
          "Idempotency key was reused with a different order.",
          {
            code: "idempotency_key_reuse",
            orderId: input.orderId,
            existingOrderId: existing.orderId,
          },
        );
      }
      return outcomeFromExisting(existing);
    }

    // Load the order to capture amount + currency. We do NOT trust the
    // caller for the amount — the order is the source of truth for what
    // the buyer owes.
    const order = await this.orders.getOrderById(input.orderId);
    if (!order) {
      throw new NotFoundError("Order not found.", { orderId: input.orderId });
    }
    if (order.status !== "pending_payment") {
      throw new ConflictError(
        "Order is not in a state that accepts a new payment.",
        {
          code: "order_not_pending_payment",
          orderId: order.id,
          status: order.status,
        },
      );
    }

    const paymentId = id("pay");
    const amount: Money = order.total;

    // Stage 1 — write the `payments` row + the `pending` initiate
    // attempt in one transaction. If the provider call later fails we
    // patch the attempt to `failure`; the parent row stays `pending`
    // so a retry with a fresh idempotency key can re-attempt.
    const { paymentRow } = await this.repo.withTransaction(async (tx) => {
      const inserted = await tx.insertPayment({
        id: paymentId,
        orderId: order.id,
        provider: provider.code,
        providerRef: null,
        currency: amount.currency,
        amount: amount.amount,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
      });
      await tx.insertAttempt({
        id: id("pat"),
        paymentId,
        kind: "initiate",
        status: "pending",
        requestPayload: serializeInitiateRequest(input, amount),
        responsePayload: null,
        errorMessage: null,
      });
      return { paymentRow: inserted };
    });

    // Stage 2 — call the provider OUTSIDE the DB transaction. A
    // long-running HTTP call should not pin a Postgres connection.
    let result: InitiateResult;
    try {
      result = await provider.initiate({
        payment: {
          id: paymentId,
          orderId: order.id,
          amount: amount.amount,
          currency: amount.currency,
        },
        customer: input.customer,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
    } catch (err) {
      // Record the failure; leave the parent row `pending` (not
      // `failed`) so a fresh idempotency key can retry. A `failed`
      // here would be a lie — we never knew if the provider received
      // the call or not.
      await this.recordAttemptFailure(paymentId, "initiate", err);
      log.error(
        { err, paymentId, providerCode: provider.code },
        "payment provider initiate failed",
      );
      throw err;
    }

    // Stage 3 — persist the outcome.
    const pending: PendingEvent[] = [];
    await this.repo.withTransaction(async (tx) => {
      const fresh = await tx.getPaymentByIdForUpdate(paymentId);
      if (!fresh) {
        // Should never happen — we just wrote it.
        throw new Error(`payment ${paymentId} vanished mid-initiate`);
      }
      const next = nextStatusForInitiate(result);
      const transition = transitionPatch(fresh.status as PaymentStatus, next);
      const updated = await tx.updatePayment(paymentId, {
        ...transition,
        providerRef: result.providerRef,
      });
      if (!updated) {
        throw new Error(`payment ${paymentId} update returned no row`);
      }

      await tx.insertAttempt({
        id: id("pat"),
        paymentId,
        kind: "initiate",
        status: "success",
        requestPayload: { providerCode: provider.code },
        responsePayload: serializeInitiateResponse(result),
        errorMessage: null,
      });

      pending.push({
        name: "payment.initiated",
        payload: {
          paymentId,
          orderId: paymentRow.orderId,
          provider: provider.code,
          outcome: result.status,
        },
      });
      pending.push({
        name: "payment.status_changed",
        payload: {
          paymentId,
          orderId: paymentRow.orderId,
          fromStatus: fresh.status as PaymentStatus,
          toStatus: next,
        },
      });
      if (next === "captured") {
        pending.push({
          name: "payment.captured",
          payload: {
            paymentId,
            orderId: paymentRow.orderId,
            provider: provider.code,
          },
        });
      }
    });
    await this.emitPending(pending);

    // Audit row lives outside the inner transaction so the audit-log
    // table cannot block the payments flow on a constraint hiccup
    // (audit is best-effort against the same data the events expose).
    await this.audit("payment_initiated", paymentId, {
      provider: provider.code,
      outcome: result.status,
    });

    // If the provider captured synchronously, drive the order to
    // `paid` AFTER the payments commit so the order transition does
    // not roll back the payments row on a freshly-invalid state.
    if (nextStatusForInitiate(result) === "captured") {
      await this.driveOrderToPaid(paymentRow.orderId, paymentId);
    }

    return outcomeFromInitiateResult(paymentId, result);
  }

  async capture(input: CapturePaymentInput): Promise<Payment> {
    const fresh = await this.repo.getPaymentById(input.paymentId);
    if (!fresh) {
      throw new NotFoundError("Payment not found.", { paymentId: input.paymentId });
    }
    if (!fresh.providerRef) {
      throw new ConflictError(
        "Payment cannot be captured before the provider has assigned a reference.",
        { code: "missing_provider_ref", paymentId: input.paymentId },
      );
    }
    const fromStatus = fresh.status as PaymentStatus;
    if (fromStatus === "captured") {
      // Idempotent re-capture: a second call after success returns the
      // current row. Logged as a no-op attempt for the audit trail.
      await this.repo.insertAttempt({
        id: id("pat"),
        paymentId: fresh.id,
        kind: "capture",
        status: "success",
        requestPayload: { note: "no-op: already captured" },
        responsePayload: null,
        errorMessage: null,
      });
      return toPayment(fresh);
    }
    if (!canTransition(fromStatus, "captured")) {
      throw new ConflictError("Payment is not in a state that accepts capture.", {
        code: "invalid_transition",
        from: fromStatus,
        to: "captured",
      });
    }

    const provider = this.resolveProvider(fresh.provider);

    // Provider call OUTSIDE the transaction.
    try {
      await provider.capture({
        payment: { id: fresh.id, providerRef: fresh.providerRef },
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
      });
    } catch (err) {
      await this.recordAttemptFailure(fresh.id, "capture", err);
      throw err;
    }

    const pending: PendingEvent[] = [];
    const updated = await this.repo.withTransaction(async (tx) => {
      const locked = await tx.getPaymentByIdForUpdate(fresh.id);
      if (!locked) {
        throw new NotFoundError("Payment not found.", { paymentId: fresh.id });
      }
      const lockedStatus = locked.status as PaymentStatus;
      if (lockedStatus === "captured") {
        return locked;
      }
      const transition = transitionPatch(lockedStatus, "captured");
      const next = await tx.updatePayment(fresh.id, transition);
      if (!next) {
        throw new NotFoundError("Payment not found.", { paymentId: fresh.id });
      }
      await tx.insertAttempt({
        id: id("pat"),
        paymentId: fresh.id,
        kind: "capture",
        status: "success",
        requestPayload: input.amount !== undefined
          ? { amount: input.amount.toString() }
          : {},
        responsePayload: null,
        errorMessage: null,
      });
      pending.push({
        name: "payment.captured",
        payload: {
          paymentId: fresh.id,
          orderId: fresh.orderId,
          provider: fresh.provider,
        },
      });
      pending.push({
        name: "payment.status_changed",
        payload: {
          paymentId: fresh.id,
          orderId: fresh.orderId,
          fromStatus: lockedStatus,
          toStatus: "captured",
        },
      });
      return next;
    });
    await this.emitPending(pending);
    await this.audit("payment_captured", fresh.id, {
      actorId: input.actorId ?? null,
    });

    await this.driveOrderToPaid(fresh.orderId, fresh.id);
    return toPayment(updated);
  }

  async refund(input: RefundPaymentInput): Promise<Payment> {
    const fresh = await this.repo.getPaymentById(input.paymentId);
    if (!fresh) {
      throw new NotFoundError("Payment not found.", { paymentId: input.paymentId });
    }
    if (!fresh.providerRef) {
      throw new ConflictError(
        "Payment has no provider reference; refund is not possible.",
        { code: "missing_provider_ref", paymentId: input.paymentId },
      );
    }
    const fromStatus = fresh.status as PaymentStatus;
    if (fromStatus === "refunded") {
      // Idempotent re-refund.
      await this.repo.insertAttempt({
        id: id("pat"),
        paymentId: fresh.id,
        kind: "refund",
        status: "success",
        requestPayload: { note: "no-op: already refunded" },
        responsePayload: null,
        errorMessage: null,
      });
      return toPayment(fresh);
    }
    if (!canTransition(fromStatus, "refunded")) {
      throw new ConflictError("Payment is not in a state that accepts refund.", {
        code: "invalid_transition",
        from: fromStatus,
        to: "refunded",
      });
    }

    const provider = this.resolveProvider(fresh.provider);

    try {
      await provider.refund({
        payment: { id: fresh.id, providerRef: fresh.providerRef },
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
    } catch (err) {
      await this.recordAttemptFailure(fresh.id, "refund", err);
      throw err;
    }

    const pending: PendingEvent[] = [];
    const updated = await this.repo.withTransaction(async (tx) => {
      const locked = await tx.getPaymentByIdForUpdate(fresh.id);
      if (!locked) {
        throw new NotFoundError("Payment not found.", { paymentId: fresh.id });
      }
      const lockedStatus = locked.status as PaymentStatus;
      if (lockedStatus === "refunded") return locked;
      const transition = transitionPatch(lockedStatus, "refunded");
      const next = await tx.updatePayment(fresh.id, transition);
      if (!next) {
        throw new NotFoundError("Payment not found.", { paymentId: fresh.id });
      }
      await tx.insertAttempt({
        id: id("pat"),
        paymentId: fresh.id,
        kind: "refund",
        status: "success",
        requestPayload: {
          ...(input.amount !== undefined ? { amount: input.amount.toString() } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
        responsePayload: null,
        errorMessage: null,
      });
      pending.push({
        name: "payment.refunded",
        payload: {
          paymentId: fresh.id,
          orderId: fresh.orderId,
          provider: fresh.provider,
        },
      });
      pending.push({
        name: "payment.status_changed",
        payload: {
          paymentId: fresh.id,
          orderId: fresh.orderId,
          fromStatus: lockedStatus,
          toStatus: "refunded",
        },
      });
      return next;
    });
    await this.emitPending(pending);
    await this.audit("payment_refunded", fresh.id, {
      actorId: input.actorId ?? null,
      reason: input.reason ?? null,
    });

    await this.driveOrderToRefunded(fresh.orderId, fresh.id);
    return toPayment(updated);
  }

  async getById(paymentId: string): Promise<PaymentWithAttempts | null> {
    const row = await this.repo.getPaymentById(paymentId);
    if (!row) return null;
    const attempts = await this.repo.listAttemptsForPayment(paymentId);
    return {
      ...toPayment(row),
      attempts: attempts.map(toPaymentAttempt),
    };
  }

  async getByOrderId(orderId: string): Promise<Payment | null> {
    const row = await this.repo.getPaymentByOrderId(orderId);
    return row ? toPayment(row) : null;
  }

  async list(query: ListPaymentsQuery): Promise<Paginated<Payment>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const { rows, total } = await this.repo.listPayments({
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      page,
      pageSize,
    });
    return {
      data: rows.map(toPayment),
      total,
      page,
      pageSize,
    };
  }

  async listAttempts(paymentId: string): Promise<PaymentAttempt[]> {
    const row = await this.repo.getPaymentById(paymentId);
    if (!row) {
      throw new NotFoundError("Payment not found.", { paymentId });
    }
    const rows = await this.repo.listAttemptsForPayment(paymentId);
    return rows.map(toPaymentAttempt);
  }

  async handleWebhook(input: HandleWebhookInput): Promise<HandleWebhookResult> {
    const provider = this.resolveProvider(input.providerCode);

    // Verify FIRST. An unverified payload never sees the database.
    let verified: VerifiedWebhook;
    try {
      verified = provider.verifyWebhookSignature({
        rawBody: input.rawBody,
        headers: input.headers,
      });
    } catch (err) {
      throw new ValidationError(
        "Webhook signature verification failed.",
        {
          code: "webhook_signature_invalid",
          provider: input.providerCode,
          reason: err instanceof Error ? err.message : "unknown",
        },
      );
    }

    const payment = await this.repo.getPaymentByProviderRef(
      input.providerCode,
      verified.providerRef,
    );
    if (!payment) {
      // Unknown ref — not necessarily an attack: a webhook may arrive
      // before our `initiate` finalises (provider's settlement engine is
      // faster than the redirect dance). Record the orphan event for
      // diagnostics and signal `ignored` so the provider does NOT retry
      // forever.
      log.warn(
        { provider: input.providerCode, providerRef: verified.providerRef },
        "webhook for unknown payment — ignoring",
      );
      return { status: "ignored", paymentId: null, event: verified.event };
    }

    const fromStatus = payment.status as PaymentStatus;
    const targetStatus = mapWebhookStatusToPaymentStatus(verified.status);

    // Idempotent re-delivery: a second `captured` event for an already-
    // `captured` payment writes a webhook attempt row but does NOT
    // re-transition. Same for refund / failed.
    if (fromStatus === targetStatus) {
      await this.repo.insertAttempt({
        id: id("pat"),
        paymentId: payment.id,
        kind: "webhook",
        status: "success",
        requestPayload: {
          event: verified.event,
          providerRef: verified.providerRef,
          status: verified.status,
          duplicate: true,
        },
        responsePayload: verified.rawPayload,
        errorMessage: null,
      });
      return { status: "accepted", paymentId: payment.id, event: verified.event };
    }

    if (isTerminal(fromStatus)) {
      // Already terminal but the new event is different — log it as a
      // failure attempt so the audit trail captures the conflict, but
      // do not re-transition. A `captured → refunded` flip is a
      // legitimate forward step (handled by the canTransition path
      // below); a `refunded → captured` flip is not, and we refuse it.
      if (!canTransition(fromStatus, targetStatus)) {
        await this.repo.insertAttempt({
          id: id("pat"),
          paymentId: payment.id,
          kind: "webhook",
          status: "failure",
          requestPayload: {
            event: verified.event,
            providerRef: verified.providerRef,
            status: verified.status,
          },
          responsePayload: verified.rawPayload,
          errorMessage: `payment is terminal in ${fromStatus}; refusing transition to ${targetStatus}`,
        });
        return {
          status: "ignored",
          paymentId: payment.id,
          event: verified.event,
        };
      }
    }

    if (!canTransition(fromStatus, targetStatus)) {
      await this.repo.insertAttempt({
        id: id("pat"),
        paymentId: payment.id,
        kind: "webhook",
        status: "failure",
        requestPayload: {
          event: verified.event,
          providerRef: verified.providerRef,
          status: verified.status,
        },
        responsePayload: verified.rawPayload,
        errorMessage: `invalid transition ${fromStatus} → ${targetStatus}`,
      });
      return {
        status: "ignored",
        paymentId: payment.id,
        event: verified.event,
      };
    }

    const pending: PendingEvent[] = [];
    await this.repo.withTransaction(async (tx) => {
      const locked = await tx.getPaymentByIdForUpdate(payment.id);
      if (!locked) {
        throw new NotFoundError("Payment not found.", { paymentId: payment.id });
      }
      const lockedStatus = locked.status as PaymentStatus;
      // Re-check after the lock — another webhook could have raced.
      if (lockedStatus === targetStatus) return;
      if (!canTransition(lockedStatus, targetStatus)) return;

      const transition = transitionPatch(lockedStatus, targetStatus);
      await tx.updatePayment(payment.id, transition);
      await tx.insertAttempt({
        id: id("pat"),
        paymentId: payment.id,
        kind: "webhook",
        status: "success",
        requestPayload: {
          event: verified.event,
          providerRef: verified.providerRef,
          status: verified.status,
        },
        responsePayload: verified.rawPayload,
        errorMessage: null,
      });
      pending.push({
        name: "payment.status_changed",
        payload: {
          paymentId: payment.id,
          orderId: payment.orderId,
          fromStatus: lockedStatus,
          toStatus: targetStatus,
        },
      });
      if (targetStatus === "captured") {
        pending.push({
          name: "payment.captured",
          payload: {
            paymentId: payment.id,
            orderId: payment.orderId,
            provider: payment.provider,
          },
        });
      }
      if (targetStatus === "refunded") {
        pending.push({
          name: "payment.refunded",
          payload: {
            paymentId: payment.id,
            orderId: payment.orderId,
            provider: payment.provider,
          },
        });
      }
      if (targetStatus === "failed") {
        pending.push({
          name: "payment.failed",
          payload: {
            paymentId: payment.id,
            orderId: payment.orderId,
            provider: payment.provider,
            reason: typeof verified.rawPayload.reason === "string"
              ? verified.rawPayload.reason
              : null,
          },
        });
      }
    });
    await this.emitPending(pending);

    if (targetStatus === "captured") {
      await this.driveOrderToPaid(payment.orderId, payment.id);
    } else if (targetStatus === "refunded") {
      await this.driveOrderToRefunded(payment.orderId, payment.id);
    }

    await this.audit("payment_webhook", payment.id, {
      provider: input.providerCode,
      event: verified.event,
      to: targetStatus,
    });

    return { status: "accepted", paymentId: payment.id, event: verified.event };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private resolveProvider(code: string): PaymentProvider {
    try {
      return this.registry.resolve(code);
    } catch (err) {
      throw new ConflictError(
        "Unknown payment provider code.",
        {
          code: "unknown_provider",
          providerCode: code,
          reason: err instanceof Error ? err.message : "unknown",
        },
      );
    }
  }

  private async recordAttemptFailure(
    paymentId: string,
    kind: "initiate" | "capture" | "refund",
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.repo.insertAttempt({
        id: id("pat"),
        paymentId,
        kind,
        status: "failure",
        requestPayload: {},
        responsePayload: null,
        errorMessage: message,
      });
    } catch (writeErr) {
      // We do not want to swallow the original provider error behind
      // an audit-write failure — log and continue, the original error
      // will surface to the caller.
      log.error(
        { err: writeErr, paymentId, kind },
        "failed to record provider failure attempt",
      );
    }
  }

  private async driveOrderToPaid(
    orderId: string,
    paymentId: string,
  ): Promise<void> {
    try {
      await this.orders.transitionStatus(orderId, "paid", {
        actorKind: "system",
        details: { paymentId },
      });
    } catch (err) {
      // Conflict here is benign in the common race: another path moved
      // the order into `paid` (or `cancelled`). Log and continue —
      // the payment is still authoritative for "we have the money".
      log.warn(
        { err, orderId, paymentId },
        "order transition pending_payment → paid did not apply (likely already transitioned)",
      );
    }
  }

  private async driveOrderToRefunded(
    orderId: string,
    paymentId: string,
  ): Promise<void> {
    try {
      await this.orders.transitionStatus(orderId, "refunded", {
        actorKind: "system",
        details: { paymentId },
      });
    } catch (err) {
      log.warn(
        { err, orderId, paymentId },
        "order transition → refunded did not apply (likely already transitioned)",
      );
    }
  }

  private async audit(
    action: string,
    paymentId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audits.recordEvent({
        entityKind: "payment",
        entityId: paymentId,
        action,
        actor: { kind: "system" },
        details,
      });
    } catch (err) {
      log.error({ err, paymentId, action }, "audit_log write failed");
    }
  }

  private async emitPending(pending: PendingEvent[]): Promise<void> {
    for (const ev of pending) {
      await (
        events.emit as <E extends EventName>(
          name: E,
          payload: EventPayload<E>,
        ) => Promise<void>
      )(ev.name, ev.payload);
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function nextStatusForInitiate(result: InitiateResult): PaymentStatus {
  switch (result.status) {
    case "captured":
      return "captured";
    case "redirect":
    case "pending":
    default:
      return "pending";
  }
}

function transitionPatch(
  from: PaymentStatus,
  to: PaymentStatus,
): { status: PaymentStatus } {
  if (!ALL_PAYMENT_STATUSES.includes(to)) {
    throw new ConflictError("Unknown target payment status.", {
      code: "invalid_transition",
      to,
    });
  }
  if (from === to) {
    return { status: to };
  }
  if (!canTransition(from, to)) {
    throw new ConflictError("Invalid payment status transition.", {
      code: "invalid_transition",
      from,
      to,
    });
  }
  return { status: to };
}

function outcomeFromInitiateResult(
  paymentId: string,
  result: InitiateResult,
): PaymentInitiateOutcome {
  switch (result.status) {
    case "redirect":
      return {
        status: "redirect",
        paymentId,
        redirectUrl: result.redirectUrl,
      };
    case "captured":
      return { status: "captured", paymentId };
    case "pending":
    default:
      return { status: "pending", paymentId };
  }
}

function outcomeFromExisting(row: {
  id: string;
  status: string;
}): PaymentInitiateOutcome {
  switch (row.status) {
    case "captured":
      return { status: "captured", paymentId: row.id };
    case "pending":
    case "authorized":
      return { status: "pending", paymentId: row.id };
    case "failed":
    case "cancelled":
    case "refunded":
    default:
      // Terminal failure on the existing row — surface as a clean
      // conflict so the caller writes a fresh row with a new
      // idempotency key.
      throw new ConflictError(
        "Existing payment is terminal; start a fresh attempt with a new idempotency key.",
        { code: "payment_terminal", paymentId: row.id, status: row.status },
      );
  }
}

function serializeInitiateRequest(
  input: InitiatePaymentInput,
  amount: Money,
): Record<string, unknown> {
  return {
    providerCode: input.providerCode,
    orderId: input.orderId,
    amount: { amount: amount.amount.toString(), currency: amount.currency },
    customer: input.customer,
    metadata: input.metadata ?? null,
  };
}

function serializeInitiateResponse(
  result: InitiateResult,
): Record<string, unknown> {
  switch (result.status) {
    case "redirect":
      return {
        status: result.status,
        providerRef: result.providerRef,
        redirectUrl: result.redirectUrl,
        rawResponse: serializeRaw(result.rawResponse),
      };
    case "captured":
    case "pending":
      return {
        status: result.status,
        providerRef: result.providerRef,
        rawResponse: serializeRaw(result.rawResponse),
      };
  }
}

function serializeRaw(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return { value: raw };
}

function mapWebhookStatusToPaymentStatus(
  status: VerifiedWebhook["status"],
): PaymentStatus {
  switch (status) {
    case "captured":
      return "captured";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
  }
}

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Default singleton wired to the runtime database, the live order
 * service, and the default provider registry. Tests construct
 * `PaymentServiceImpl` directly with fakes for any of these.
 */
export const paymentService: PaymentService = new PaymentServiceImpl(
  createPaymentsRepository(),
);
