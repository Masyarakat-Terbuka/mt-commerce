/**
 * Audit repository — Drizzle queries, no domain logic.
 *
 * Like the other module repositories, this is constructed with a `db`
 * instance so callers can share a transaction by passing the active `tx`
 * object from a `db.transaction(async (tx) => ...)` block. The audit row
 * write must land in the same transaction as the change it describes,
 * otherwise a partial failure could leave audit and reality out of sync.
 *
 * The default singleton resolves the lazy `db` proxy from `db/client.ts`.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  auditLog,
  type AuditLogRow,
  type NewAuditLogRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface AuditListResult {
  rows: AuditLogRow[];
  total: number;
}

export interface AuditListFilters {
  entityKind: string;
  entityId: string;
  page: number;
  pageSize: number;
}

export interface AuditRepository {
  insertEvent(row: NewAuditLogRow): Promise<AuditLogRow>;
  listForEntity(filters: AuditListFilters): Promise<AuditListResult>;
}

export function createAuditRepository(db: Db = defaultDb): AuditRepository {
  return {
    async insertEvent(row: NewAuditLogRow): Promise<AuditLogRow> {
      const [inserted] = await db.insert(auditLog).values(row).returning();
      if (!inserted) {
        throw new Error("insertEvent: returning() yielded no rows");
      }
      return inserted;
    },

    async listForEntity(
      filters: AuditListFilters,
    ): Promise<AuditListResult> {
      const where = and(
        eq(auditLog.entityKind, filters.entityKind),
        eq(auditLog.entityId, filters.entityId),
      );

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },
  };
}
