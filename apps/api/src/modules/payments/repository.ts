/**
 * Payments repository — Drizzle queries, no domain logic.
 *
 * Mirrors the orders/checkout pattern: returns Drizzle row types,
 * leaves DTO shaping to the service. Constructed via
 * `createPaymentsRepository(db)` so tests can inject an in-memory fake
 * by implementing the `PaymentsRepository` shape.
 *
 * `withTransaction(fn)` runs the callback inside a single Postgres
 * transaction. The payments service composes "insert payment + insert
 * initiate-attempt" inside one unit so a partial failure cannot leave a
 * payment row without its corresponding attempt row.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  paymentAttempts,
  payments,
  type NewPaymentAttemptRow,
  type NewPaymentRow,
  type PaymentAttemptRow,
  type PaymentRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { PaymentStatus } from "./state.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface PaymentListFilters {
  orderId?: string;
  status?: PaymentStatus;
  provider?: string;
  page: number;
  pageSize: number;
}

export interface PaymentListResult {
  rows: PaymentRow[];
  total: number;
}

export interface PaymentUpdatePatch {
  status?: PaymentStatus;
  providerRef?: string | null;
}

export interface PaymentsRepository {
  // Payments
  insertPayment(row: NewPaymentRow): Promise<PaymentRow>;
  getPaymentById(id: string): Promise<PaymentRow | null>;
  /**
   * Same as `getPaymentById` but acquires a `FOR UPDATE` row lock —
   * used by `capture` / `refund` to serialise concurrent transitions.
   */
  getPaymentByIdForUpdate(id: string): Promise<PaymentRow | null>;
  getPaymentByIdempotencyKey(key: string): Promise<PaymentRow | null>;
  /**
   * Most-recent payment for an order (one per order in v0.1, but the
   * read shape future-proofs the multi-payment iteration).
   */
  getPaymentByOrderId(orderId: string): Promise<PaymentRow | null>;
  /**
   * Resolve a payment by its provider's id. Used by the webhook
   * dispatcher. Returns null when no payment carries this `(provider,
   * provider_ref)` pair — webhooks for unknown refs are recorded but
   * ignored.
   */
  getPaymentByProviderRef(
    provider: string,
    providerRef: string,
  ): Promise<PaymentRow | null>;
  listPayments(filters: PaymentListFilters): Promise<PaymentListResult>;
  /**
   * Find non-terminal payments older than `olderThan` whose `providerRef`
   * is non-null — i.e. payments the provider knows about but the
   * platform has not heard the resolution of. Used by the reconciliation
   * loop. Newest-first; capped at `limit`.
   */
  listPaymentsForReconcile(opts: {
    olderThan: Date;
    limit: number;
  }): Promise<PaymentRow[]>;
  updatePayment(
    id: string,
    patch: PaymentUpdatePatch,
  ): Promise<PaymentRow | null>;

  // Attempts
  insertAttempt(row: NewPaymentAttemptRow): Promise<PaymentAttemptRow>;
  listAttemptsForPayment(paymentId: string): Promise<PaymentAttemptRow[]>;

  withTransaction<T>(fn: (tx: PaymentsRepository) => Promise<T>): Promise<T>;
}

export function createPaymentsRepository(
  db: Db = defaultDb,
): PaymentsRepository {
  return {
    async insertPayment(row) {
      const [inserted] = await db.insert(payments).values(row).returning();
      if (!inserted)
        throw new Error("insertPayment: returning() yielded no rows");
      return inserted;
    },

    async getPaymentById(id) {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, id))
        .limit(1);
      return row ?? null;
    },

    async getPaymentByIdForUpdate(id) {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, id))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async getPaymentByIdempotencyKey(key) {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.idempotencyKey, key))
        .limit(1);
      return row ?? null;
    },

    async getPaymentByOrderId(orderId) {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(desc(payments.createdAt))
        .limit(1);
      return row ?? null;
    },

    async getPaymentByProviderRef(provider, providerRef) {
      const [row] = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.provider, provider),
            eq(payments.providerRef, providerRef),
            // Defensive: the partial-style index walks rows where
            // provider_ref is non-null, but a NULL row could still
            // match the equality if Postgres ever changed semantics.
            // Pin the predicate explicitly.
            isNotNull(payments.providerRef),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listPayments(filters) {
      const conditions: SQL[] = [];
      if (filters.orderId)
        conditions.push(eq(payments.orderId, filters.orderId));
      if (filters.status) conditions.push(eq(payments.status, filters.status));
      if (filters.provider)
        conditions.push(eq(payments.provider, filters.provider));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(payments)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(payments)
        .where(where ?? sql`true`)
        .orderBy(desc(payments.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async listPaymentsForReconcile({ olderThan, limit }) {
      // The candidate set is "non-terminal AND has a providerRef AND
      // the row hasn't been touched in <olderThan> minutes". We use
      // `updated_at` rather than `created_at` so a row that was retried
      // recently doesn't show up before its retry has had a chance to
      // settle.
      const NON_TERMINAL: PaymentStatus[] = [
        "pending",
        "authorized",
        "captured",
      ];
      // `captured` is non-terminal in the sense that a refund event can
      // still arrive — but a captured payment doesn't need a status
      // re-fetch from the provider to recover. We narrow to the truly
      // open states.
      const OPEN: PaymentStatus[] = ["pending", "authorized"];
      void NON_TERMINAL;
      return db
        .select()
        .from(payments)
        .where(
          and(
            inArray(payments.status, OPEN),
            isNotNull(payments.providerRef),
            lt(payments.updatedAt, olderThan),
          ),
        )
        .orderBy(desc(payments.createdAt))
        .limit(limit);
    },

    async updatePayment(id, patch) {
      const [updated] = await db
        .update(payments)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(payments.id, id))
        .returning();
      return updated ?? null;
    },

    async insertAttempt(row) {
      const [inserted] = await db
        .insert(paymentAttempts)
        .values(row)
        .returning();
      if (!inserted)
        throw new Error("insertAttempt: returning() yielded no rows");
      return inserted;
    },

    async listAttemptsForPayment(paymentId) {
      return db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.paymentId, paymentId))
        .orderBy(asc(paymentAttempts.createdAt));
    },

    async withTransaction(fn) {
      return db.transaction(async (tx) =>
        fn(createPaymentsRepository(tx as unknown as Db)),
      );
    },
  };
}
