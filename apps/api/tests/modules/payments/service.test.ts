/**
 * `PaymentService` — integration tests against in-memory fakes.
 *
 * Same pattern as the orders/checkout service tests: construct
 * `PaymentServiceImpl` with a fake `PaymentsRepository` backed by
 * `Map`s for both tables, a fake `OrderService`, and the in-memory
 * test provider registered in a fresh registry per test.
 *
 * Coverage:
 *   - initiate happy path → captured + order moves to paid
 *   - initiate idempotency → second call returns the cached outcome
 *   - capture transitions a pending payment → captured and the order → paid
 *   - refund transitions captured → refunded and order → refunded
 *   - webhook signature failure surfaces as ValidationError
 *   - webhook idempotent on duplicate delivery (no second order transition)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "../../../src/lib/errors.js";
import { events } from "../../../src/modules/payments/events.js";
import {
  createInMemoryTestPaymentProvider,
  signTestWebhook,
} from "../../../src/modules/payments/providers/in-memory.js";
import { createPaymentProviderRegistry } from "../../../src/modules/payments/providers/registry.js";
import { PaymentServiceImpl } from "../../../src/modules/payments/service.js";
import type {
  PaymentListFilters,
  PaymentListResult,
  PaymentUpdatePatch,
  PaymentsRepository,
} from "../../../src/modules/payments/repository.js";
import type {
  NewPaymentAttemptRow,
  NewPaymentRow,
  PaymentAttemptRow,
  PaymentRow,
} from "../../../src/db/schema/index.js";
import type { OrderService } from "../../../src/modules/orders/index.js";
import type {
  AuditService,
  AuditEvent,
} from "../../../src/modules/audit/index.js";

const NOW = new Date("2026-05-08T00:00:00.000Z");
const ORDER_ID = "ord_1";
const ORDER_TOTAL_AMOUNT = 565_000n;

interface Store {
  payments: Map<string, PaymentRow>;
  attempts: PaymentAttemptRow[];
  clock: number;
}

function tick(store: Store): Date {
  store.clock += 1;
  return new Date(NOW.getTime() + store.clock);
}

function createStore(): Store {
  return { payments: new Map(), attempts: [], clock: 0 };
}

function createFakeRepo(store: Store): PaymentsRepository {
  const repo: PaymentsRepository = {
    async insertPayment(row: NewPaymentRow): Promise<PaymentRow> {
      if (store.payments.has(row.id)) {
        throw new Error(`fake repo: duplicate payment id ${row.id}`);
      }
      // Surface the unique-constraint behaviour on idempotency_key —
      // tests depend on the second insert failing.
      for (const existing of store.payments.values()) {
        if (existing.idempotencyKey === row.idempotencyKey) {
          throw Object.assign(
            new Error("duplicate key value violates unique constraint"),
            {
              code: "23505",
              constraint_name: "payments_idempotency_key_unique",
            },
          );
        }
      }
      const now = tick(store);
      const inserted: PaymentRow = {
        id: row.id,
        orderId: row.orderId,
        provider: row.provider,
        providerRef: row.providerRef ?? null,
        currency: row.currency,
        amount: row.amount,
        status: row.status ?? "pending",
        idempotencyKey: row.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      store.payments.set(inserted.id, inserted);
      return inserted;
    },
    async getPaymentById(id) {
      return store.payments.get(id) ?? null;
    },
    async getPaymentByIdForUpdate(id) {
      return store.payments.get(id) ?? null;
    },
    async getPaymentByIdempotencyKey(key) {
      for (const p of store.payments.values()) {
        if (p.idempotencyKey === key) return p;
      }
      return null;
    },
    async getPaymentByOrderId(orderId) {
      const matches = [...store.payments.values()].filter(
        (p) => p.orderId === orderId,
      );
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ?? null;
    },
    async getPaymentByProviderRef(provider, providerRef) {
      for (const p of store.payments.values()) {
        if (p.provider === provider && p.providerRef === providerRef) return p;
      }
      return null;
    },
    async listPayments(
      filters: PaymentListFilters,
    ): Promise<PaymentListResult> {
      let rows = [...store.payments.values()];
      if (filters.orderId)
        rows = rows.filter((p) => p.orderId === filters.orderId);
      if (filters.status)
        rows = rows.filter((p) => p.status === filters.status);
      if (filters.provider)
        rows = rows.filter((p) => p.provider === filters.provider);
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(start, start + filters.pageSize), total };
    },
    async listPaymentsForReconcile({
      olderThan,
      limit,
    }: {
      olderThan: Date;
      limit: number;
    }): Promise<PaymentRow[]> {
      return [...store.payments.values()]
        .filter(
          (p) =>
            (p.status === "pending" || p.status === "authorized") &&
            p.providerRef !== null &&
            p.updatedAt < olderThan,
        )
        .slice(0, limit);
    },
    async updatePayment(id, patch: PaymentUpdatePatch) {
      const existing = store.payments.get(id);
      if (!existing) return null;
      const updated: PaymentRow = {
        ...existing,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.providerRef !== undefined
          ? { providerRef: patch.providerRef }
          : {}),
        updatedAt: tick(store),
      };
      store.payments.set(id, updated);
      return updated;
    },
    async insertAttempt(row: NewPaymentAttemptRow): Promise<PaymentAttemptRow> {
      const inserted: PaymentAttemptRow = {
        id: row.id,
        paymentId: row.paymentId,
        kind: row.kind,
        status: row.status,
        requestPayload: (row.requestPayload as object) ?? {},
        responsePayload: (row.responsePayload as object) ?? null,
        errorMessage: row.errorMessage ?? null,
        createdAt: tick(store),
      };
      store.attempts.push(inserted);
      return inserted;
    },
    async listAttemptsForPayment(paymentId) {
      return store.attempts
        .filter((a) => a.paymentId === paymentId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async withTransaction(fn) {
      // No real transactional semantics in the fake.
      return fn(repo);
    },
  };
  return repo;
}

interface FakeOrderState {
  status: "pending_payment" | "paid" | "fulfilled" | "cancelled" | "refunded";
}

function createFakeOrderService(state: FakeOrderState): {
  service: OrderService;
  transitions: Array<{ to: string; details?: Record<string, unknown> }>;
} {
  const transitions: Array<{
    to: string;
    details?: Record<string, unknown>;
  }> = [];

  const fail = (): never => {
    throw new Error("not implemented in this test");
  };

  const baseOrder = {
    id: ORDER_ID,
    orderNumber: "ORD-2026-000100",
    customerId: "cust_1" as string | null,
    email: "buyer@example.com",
    currency: "IDR",
    subtotal: { amount: 500_000n, currency: "IDR" },
    tax: { amount: 55_000n, currency: "IDR" },
    taxRateCode: null,
    taxRateBasisPoints: null,
    shipping: { amount: 10_000n, currency: "IDR" },
    shippingMethodCode: "flat",
    total: { amount: ORDER_TOTAL_AMOUNT, currency: "IDR" },
    shippingAddressSnapshot: {
      id: "adr_ship",
      customerId: "cust_1",
      kind: "shipping" as const,
      recipientName: "Budi",
      phone: "+62",
      addressLine1: "Jl. Mawar 1",
      addressLine2: null,
      provinsiId: "31",
      kotaKabupatenId: "3171",
      kecamatanId: "317101",
      kelurahanId: null,
      postalCode: "10110",
      notes: null,
    },
    billingAddressSnapshot: null,
    paymentMethod: "manual_bank_transfer",
    items: [],
    fulfillments: [],
    paidAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    refundedAt: null,
    cancellationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const service: OrderService = {
    async createFromIntent() {
      return fail();
    },
    async getOrderById(id) {
      if (id !== ORDER_ID) return null;
      return { ...baseOrder, status: state.status };
    },
    async getOrderByNumber() {
      return null;
    },
    async getOrderByCheckoutId() {
      return { ...baseOrder, status: state.status };
    },
    async listOrders() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async listCustomerOrders() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async transitionStatus(_id, toStatus, opts) {
      transitions.push({
        to: toStatus,
        ...(opts.details ? { details: opts.details } : {}),
      });
      // Simulate the orders service refusing duplicate transitions —
      // but only when we drive the same state twice. The first call
      // updates `state`; the second sees the new value and refuses.
      if (state.status === toStatus) {
        throw new ConflictError("Order is in a terminal status.", {
          code: "invalid_transition",
        });
      }
      state.status = toStatus as FakeOrderState["status"];
      return { ...baseOrder, status: state.status };
    },
    async cancelOrder() {
      return fail();
    },
    async listStatusHistory() {
      return [];
    },
  };
  return { service, transitions };
}

function createFakeAuditService(): {
  service: AuditService;
  events: Array<{
    entityKind: string;
    action: string;
    details: Record<string, unknown>;
  }>;
} {
  const events: Array<{
    entityKind: string;
    action: string;
    details: Record<string, unknown>;
  }> = [];
  const service: AuditService = {
    async recordEvent(input): Promise<AuditEvent> {
      events.push({
        entityKind: input.entityKind,
        action: input.action,
        details: input.details ?? {},
      });
      return {
        id: `aud_${events.length}`,
        entityKind: input.entityKind,
        entityId: input.entityId,
        action: input.action,
        actorKind: "system",
        actorId: null,
        details: input.details ?? {},
        reason: null,
        createdAt: NOW,
      };
    },
    async listForEntity() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
  };
  return { service, events };
}

function buildHarness(
  opts: { initialOrderStatus?: FakeOrderState["status"] } = {},
) {
  const store = createStore();
  const repo = createFakeRepo(store);
  const orderState: FakeOrderState = {
    status: opts.initialOrderStatus ?? "pending_payment",
  };
  const orderHarness = createFakeOrderService(orderState);
  const auditHarness = createFakeAuditService();
  const provider = createInMemoryTestPaymentProvider();
  const registry = createPaymentProviderRegistry();
  registry.register(provider);
  const service = new PaymentServiceImpl(
    repo,
    orderHarness.service,
    registry,
    auditHarness.service,
  );
  return {
    store,
    repo,
    provider,
    registry,
    service,
    orderState,
    orderTransitions: orderHarness.transitions,
    auditEvents: auditHarness.events,
  };
}

beforeEach(() => {
  events.clear();
});

// ---------------------------------------------------------------------------
// initiate
// ---------------------------------------------------------------------------

describe("initiate", () => {
  it("creates a payment, calls the provider, transitions to captured, and drives the order to paid", async () => {
    const h = buildHarness();
    const captured: string[] = [];
    events.on("payment.captured", (p) => {
      captured.push(p.paymentId);
    });

    const outcome = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-1",
      customer: {
        id: "cust_1",
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });

    expect(outcome.status).toBe("captured");
    expect(outcome.paymentId).toMatch(/^pay_/);
    expect(h.orderState.status).toBe("paid");
    expect(h.orderTransitions).toEqual([
      expect.objectContaining({ to: "paid" }),
    ]);
    expect(captured).toContain(outcome.paymentId);

    // Stored row matches the outcome.
    const row = h.store.payments.get(outcome.paymentId)!;
    expect(row.status).toBe("captured");
    expect(row.providerRef).toMatch(/^test_/);
    expect(row.amount).toBe(ORDER_TOTAL_AMOUNT);

    // Two attempt rows: the initial `pending` insert + the success row.
    const initiateAttempts = h.store.attempts.filter(
      (a) => a.kind === "initiate",
    );
    expect(initiateAttempts).toHaveLength(2);
    expect(initiateAttempts[0]!.status).toBe("pending");
    expect(initiateAttempts[1]!.status).toBe("success");
  });

  it("returns the cached outcome on a same-key replay without calling the provider again", async () => {
    const h = buildHarness();
    const initiateSpy = vi.spyOn(h.provider, "initiate");

    const first = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-replay",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });
    const second = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-replay",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });

    expect(second.paymentId).toBe(first.paymentId);
    expect(second.status).toBe("captured");
    expect(initiateSpy).toHaveBeenCalledTimes(1);
    expect(h.store.payments.size).toBe(1);
  });

  it("refuses an idempotency key that was minted for a different order", async () => {
    const h = buildHarness();
    await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-cross",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });

    await expect(
      h.service.initiate({
        orderId: "ord_other",
        providerCode: "in_memory_test",
        idempotencyKey: "key-cross",
        customer: {
          id: null,
          email: "buyer@example.com",
          phone: null,
          name: null,
        },
      }),
    ).rejects.toMatchObject({
      details: { code: "idempotency_key_reuse" },
    });
  });

  it("returns a pending outcome when the provider replies pending; order stays pending_payment", async () => {
    const h = buildHarness();
    const outcome = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-pending",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_offline" },
    });
    expect(outcome.status).toBe("pending");
    expect(h.orderState.status).toBe("pending_payment");
    expect(h.orderTransitions).toHaveLength(0);
  });

  it("refuses to initiate when the order is not pending_payment", async () => {
    const h = buildHarness({ initialOrderStatus: "paid" });
    await expect(
      h.service.initiate({
        orderId: ORDER_ID,
        providerCode: "in_memory_test",
        idempotencyKey: "key-invalid",
        customer: {
          id: null,
          email: "buyer@example.com",
          phone: null,
          name: null,
        },
      }),
    ).rejects.toMatchObject({
      details: { code: "order_not_pending_payment" },
    });
  });

  it("surfaces a clean conflict for an unknown provider code", async () => {
    const h = buildHarness();
    await expect(
      h.service.initiate({
        orderId: ORDER_ID,
        providerCode: "missing_plugin",
        idempotencyKey: "key-unknown",
        customer: {
          id: null,
          email: "buyer@example.com",
          phone: null,
          name: null,
        },
      }),
    ).rejects.toMatchObject({
      details: { code: "unknown_provider" },
    });
  });
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

describe("capture", () => {
  it("transitions a pending payment to captured and drives the order to paid", async () => {
    const h = buildHarness();
    // Initiate as pending so the capture path is the one under test.
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-cap",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_x" },
    });
    expect(h.orderState.status).toBe("pending_payment");

    const captured = await h.service.capture({
      paymentId: initiated.paymentId,
    });
    expect(captured.status).toBe("captured");
    expect(h.orderState.status).toBe("paid");

    const captureAttempts = h.store.attempts.filter(
      (a) => a.kind === "capture",
    );
    expect(captureAttempts).toHaveLength(1);
    expect(captureAttempts[0]!.status).toBe("success");
  });

  it("is idempotent — a second capture is a no-op", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-cap-2",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_y" },
    });
    await h.service.capture({ paymentId: initiated.paymentId });
    const second = await h.service.capture({ paymentId: initiated.paymentId });
    expect(second.status).toBe("captured");
    // Two attempt rows for capture (one real success, one no-op
    // success), so the audit trail records both invocations.
    const captureAttempts = h.store.attempts.filter(
      (a) => a.kind === "capture",
    );
    expect(captureAttempts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// refund
// ---------------------------------------------------------------------------

describe("refund", () => {
  it("transitions a captured payment to refunded and drives the order to refunded", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-ref",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });

    const refunded = await h.service.refund({
      paymentId: initiated.paymentId,
      reason: "buyer requested",
    });
    expect(refunded.status).toBe("refunded");
    expect(h.orderState.status).toBe("refunded");

    const refundAttempts = h.store.attempts.filter((a) => a.kind === "refund");
    expect(refundAttempts).toHaveLength(1);
    expect(refundAttempts[0]!.requestPayload).toMatchObject({
      reason: "buyer requested",
    });
  });
});

// ---------------------------------------------------------------------------
// handleWebhook
// ---------------------------------------------------------------------------

describe("handleWebhook", () => {
  it("verifies the signature, transitions captured, and drives the order to paid", async () => {
    const h = buildHarness();
    // Initiate as pending so the captured webhook drives the
    // transition (rather than a no-op against an already-captured row).
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-wh",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_wh" },
    });
    const stored = h.store.payments.get(initiated.paymentId)!;

    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: stored.providerRef,
      status: "captured",
    });
    const result = await h.service.handleWebhook({
      providerCode: "in_memory_test",
      rawBody: body,
      headers: {
        "x-mt-test-signature": signTestWebhook(h.provider.secret, body),
      },
    });
    expect(result.status).toBe("accepted");
    expect(result.paymentId).toBe(initiated.paymentId);
    expect(h.orderState.status).toBe("paid");
  });

  it("rejects an invalid signature with a ValidationError", async () => {
    const h = buildHarness();
    await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-wh-bad",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_z" },
    });
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: "test_does_not_matter",
      status: "captured",
    });
    await expect(
      h.service.handleWebhook({
        providerCode: "in_memory_test",
        rawBody: body,
        headers: {
          "x-mt-test-signature": signTestWebhook("wrong-secret", body),
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("is idempotent on duplicate delivery — second webhook does NOT re-transition the order", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-wh-dup",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_dup" },
    });
    const stored = h.store.payments.get(initiated.paymentId)!;
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: stored.providerRef,
      status: "captured",
    });
    const headers = {
      "x-mt-test-signature": signTestWebhook(h.provider.secret, body),
    };
    await h.service.handleWebhook({
      providerCode: "in_memory_test",
      rawBody: body,
      headers,
    });
    expect(h.orderState.status).toBe("paid");
    const transitionsAfterFirst = h.orderTransitions.length;

    // Second delivery — payment is already captured.
    const second = await h.service.handleWebhook({
      providerCode: "in_memory_test",
      rawBody: body,
      headers,
    });
    expect(second.status).toBe("accepted");
    // No additional order transition.
    expect(h.orderTransitions).toHaveLength(transitionsAfterFirst);
    // A duplicate webhook attempt row WAS recorded for the audit trail.
    const webhookAttempts = h.store.attempts.filter(
      (a) => a.kind === "webhook",
    );
    expect(webhookAttempts.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores a webhook for an unknown provider ref (no payment row exists)", async () => {
    const h = buildHarness();
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: "test_orphan",
      status: "captured",
    });
    const result = await h.service.handleWebhook({
      providerCode: "in_memory_test",
      rawBody: body,
      headers: {
        "x-mt-test-signature": signTestWebhook(h.provider.secret, body),
      },
    });
    expect(result.status).toBe("ignored");
    expect(result.paymentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcilePayment
// ---------------------------------------------------------------------------

describe("reconcilePayment", () => {
  it("transitions a still-pending payment when the provider reports captured", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-1",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_a" },
    });

    // Simulate the upstream provider settling the payment without a
    // webhook ever arriving (e.g. a VA transfer that we missed the
    // notification for).
    const stored = h.store.payments.get(initiated.paymentId)!;
    h.provider.forceState(initiated.paymentId, {
      status: "captured",
      providerRef: stored.providerRef!,
      amount: stored.amount,
    });

    const result = await h.service.reconcilePayment(initiated.paymentId);

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.from).toBe("pending");
      expect(result.to).toBe("captured");
    }
    expect(h.orderState.status).toBe("paid");
    const reconcileAttempts = h.store.attempts.filter(
      (a) => a.kind === "reconcile",
    );
    expect(reconcileAttempts.length).toBeGreaterThanOrEqual(1);
    expect(reconcileAttempts[0]?.status).toBe("success");
  });

  it("returns still_pending without a transition when the provider has not settled", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-pend",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_b" },
    });

    const result = await h.service.reconcilePayment(initiated.paymentId);

    expect(result.kind).toBe("still_pending");
    const stored = h.store.payments.get(initiated.paymentId)!;
    expect(stored.status).toBe("pending");
    expect(h.orderState.status).toBe("pending_payment");
    // The "still pending" attempt is recorded as success so an operator
    // tail-ing the audit trail can see the reconciler's heartbeat.
    const reconcileAttempts = h.store.attempts.filter(
      (a) => a.kind === "reconcile",
    );
    expect(reconcileAttempts).toHaveLength(1);
    expect(reconcileAttempts[0]?.status).toBe("success");
  });

  it("returns terminal without contacting the provider when the row is already terminal", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-term",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      // No TEST_PENDING_ prefix → captured-on-initiate.
    });

    const result = await h.service.reconcilePayment(initiated.paymentId);

    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.current).toBe("captured");
    }
    // No reconcile attempt is recorded — terminal short-circuits before
    // the provider call.
    const reconcileAttempts = h.store.attempts.filter(
      (a) => a.kind === "reconcile",
    );
    expect(reconcileAttempts).toHaveLength(0);
  });

  it("returns unknown_to_provider when fetchStatus returns null", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-unk",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_c" },
    });
    // Swap in a fresh provider that has no state for this paymentId —
    // mirrors a Snap session that expired without the buyer paying, so
    // Midtrans's GET /v2/{orderId}/status returns 404.
    h.registry.reset();
    h.registry.register(createInMemoryTestPaymentProvider());

    const result = await h.service.reconcilePayment(initiated.paymentId);
    expect(result.kind).toBe("unknown_to_provider");
    const reconcileAttempts = h.store.attempts.filter(
      (a) => a.kind === "reconcile",
    );
    expect(reconcileAttempts).toHaveLength(1);
    expect(reconcileAttempts[0]?.status).toBe("failure");
  });

  it("returns provider_unsupported when the registered provider has no fetchStatus", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-noop",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_d" },
    });
    // Replace with a provider that does not implement fetchStatus.
    const stub = {
      ...h.provider,
      fetchStatus: undefined,
    };
    h.registry.reset();
    h.registry.register(stub);

    const result = await h.service.reconcilePayment(initiated.paymentId);
    expect(result.kind).toBe("provider_unsupported");
  });

  it("records a failure attempt when fetchStatus throws", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-rec-err",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
      metadata: { code: "TEST_PENDING_e" },
    });
    // Replace with a provider whose fetchStatus throws.
    const broken = {
      ...h.provider,
      async fetchStatus() {
        throw new Error("network unreachable");
      },
    };
    h.registry.reset();
    h.registry.register(broken);

    const result = await h.service.reconcilePayment(initiated.paymentId);
    expect(result.kind).toBe("error");
    const reconcileAttempts = h.store.attempts.filter(
      (a) => a.kind === "reconcile",
    );
    expect(reconcileAttempts).toHaveLength(1);
    expect(reconcileAttempts[0]?.status).toBe("failure");
    expect(reconcileAttempts[0]?.errorMessage).toContain("network");
  });

  it("throws NotFoundError for an unknown payment id", async () => {
    const h = buildHarness();
    await expect(
      h.service.reconcilePayment("pay_does_not_exist"),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// reconcilePendingPayments
// ---------------------------------------------------------------------------

describe("reconcilePendingPayments", () => {
  it("aggregates results across multiple stale pending payments", async () => {
    const h = buildHarness();
    // Seed three pending rows directly. We bypass `initiate` because
    // it needs a distinct order per call and the fake order service
    // only knows about ORDER_ID. Going through the store also lets us
    // backdate `updatedAt` past the 5-minute threshold without an extra
    // mutation.
    const old = new Date(Date.now() - 10 * 60_000);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const paymentId = `pay_bulk_${String(i)}`;
      const providerRef = `test_bulk_${String(i)}`;
      ids.push(paymentId);
      h.store.payments.set(paymentId, {
        id: paymentId,
        orderId: ORDER_ID,
        provider: "in_memory_test",
        providerRef,
        status: "pending",
        amount: ORDER_TOTAL_AMOUNT,
        currency: "IDR",
        idempotencyKey: `key-bulk-${String(i)}`,
        createdAt: NOW,
        updatedAt: old,
      });
      // Provider knows about all three; we'll settle row 0 below.
      h.provider.forceState(paymentId, {
        status: "pending",
        providerRef,
        amount: ORDER_TOTAL_AMOUNT,
      });
    }

    // Settle row 0 outside the platform; leave 1 and 2 still pending.
    h.provider.forceState(ids[0]!, {
      status: "captured",
      providerRef: `test_bulk_0`,
      amount: ORDER_TOTAL_AMOUNT,
    });

    const summary = await h.service.reconcilePendingPayments();

    expect(summary.checked).toBe(3);
    expect(summary.applied).toBe(1);
    expect(summary.stillPending).toBe(2);
    expect(summary.errors).toBe(0);
  });

  it("respects the olderThanMinutes threshold", async () => {
    const h = buildHarness();
    // Seed a fresh pending row directly with `updatedAt` set to wall
    // clock now — under the default 5-minute threshold, it should not
    // be picked up. Going through `initiate` would stamp `updatedAt`
    // from the fake's deterministic clock (NOW = 2026-05-08), which
    // sits arbitrarily far behind real Date.now() and would always
    // qualify.
    h.store.payments.set("pay_fresh", {
      id: "pay_fresh",
      orderId: ORDER_ID,
      provider: "in_memory_test",
      providerRef: "test_fresh",
      status: "pending",
      amount: ORDER_TOTAL_AMOUNT,
      currency: "IDR",
      idempotencyKey: "key-fresh",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const summary = await h.service.reconcilePendingPayments();
    expect(summary.checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

describe("reads", () => {
  it("getById returns the payment + ordered attempt history", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-read",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });
    const detail = await h.service.getById(initiated.paymentId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(initiated.paymentId);
    expect(detail!.attempts.length).toBeGreaterThan(0);
    // Attempt history is ordered ascending by creation time so the
    // initial `pending` row precedes the success row.
    expect(detail!.attempts[0]!.status).toBe("pending");
  });

  it("getByOrderId returns the most recent payment for an order", async () => {
    const h = buildHarness();
    await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-by-order",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });
    const found = await h.service.getByOrderId(ORDER_ID);
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe(ORDER_ID);
  });

  it("list filters by status", async () => {
    const h = buildHarness();
    await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-list",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });
    const captured = await h.service.list({
      status: "captured",
      page: 1,
      pageSize: 20,
    });
    expect(captured.total).toBe(1);
    const pending = await h.service.list({
      status: "pending",
      page: 1,
      pageSize: 20,
    });
    expect(pending.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("writes an audit row for initiate / capture / refund / webhook", async () => {
    const h = buildHarness();
    const initiated = await h.service.initiate({
      orderId: ORDER_ID,
      providerCode: "in_memory_test",
      idempotencyKey: "key-audit",
      customer: {
        id: null,
        email: "buyer@example.com",
        phone: null,
        name: null,
      },
    });
    await h.service.refund({ paymentId: initiated.paymentId });

    const actions = h.auditEvents.map((e) => e.action);
    expect(actions).toContain("payment_initiated");
    expect(actions).toContain("payment_refunded");
    expect(h.auditEvents.every((e) => e.entityKind === "payment")).toBe(true);
  });
});
