/**
 * Notification repository — Drizzle queries, no domain logic.
 *
 * Same pattern as the catalog/customer/checkout repositories: returns
 * Drizzle row types and lets the service shape DTOs through `mappers.ts`.
 *
 * The two write paths (insert + update-status) are separate methods rather
 * than a single upsert because the service composes them around the channel
 * call — insert as `pending` BEFORE the adapter runs, then update to
 * `sent`/`failed` AFTER. Splitting them lets the audit row exist even if
 * the channel throws asynchronously.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  notifications,
  type NewNotificationRow,
  type NotificationRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type {
  NotificationChannelId,
  NotificationKind,
  NotificationStatus,
} from "./types.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface NotificationListFilters {
  channel?: NotificationChannelId;
  kind?: NotificationKind;
  status?: NotificationStatus;
  page: number;
  pageSize: number;
}

export interface NotificationListResult {
  rows: NotificationRow[];
  total: number;
}

export interface NotificationRepository {
  insert(row: NewNotificationRow): Promise<NotificationRow>;
  getById(id: string): Promise<NotificationRow | null>;
  /**
   * Look up the existing row for an `(event_id, kind, channel)` triple.
   * Used by the service's idempotency guard: if the listener catches a
   * 23505 from the partial unique index on insert, it falls back to this
   * read to surface the prior row to the caller. Returns `null` when no
   * row matches (e.g. the unique violation is on a different constraint).
   */
  getByEventTriple(
    eventId: string,
    kind: NotificationKind,
    channel: NotificationChannelId,
  ): Promise<NotificationRow | null>;
  list(filters: NotificationListFilters): Promise<NotificationListResult>;
  /**
   * Mark the row's terminal status. We only ever transition `pending` →
   * `sent` or `pending` → `failed` once; the service does not retry through
   * the same row. (Future retry support adds a separate `attempts` table.)
   */
  markStatus(
    id: string,
    status: NotificationStatus,
    errorMessage: string | null,
  ): Promise<NotificationRow | null>;
}

export function createNotificationRepository(
  db: Db = defaultDb,
): NotificationRepository {
  return {
    async insert(row: NewNotificationRow): Promise<NotificationRow> {
      const [inserted] = await db.insert(notifications).values(row).returning();
      if (!inserted) {
        throw new Error("insert notification: returning() yielded no rows");
      }
      return inserted;
    },

    async getById(id: string): Promise<NotificationRow | null> {
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, id))
        .limit(1);
      return row ?? null;
    },

    async getByEventTriple(
      eventId: string,
      kind: NotificationKind,
      channel: NotificationChannelId,
    ): Promise<NotificationRow | null> {
      // Three-column equality select. The partial unique index on the same
      // triple makes this an index-only seek when a duplicate exists; for
      // misses (the common case under low duplicate-event volume) the
      // planner still uses the index thanks to the leading `event_id` column.
      const [row] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.eventId, eventId),
            eq(notifications.kind, kind),
            eq(notifications.channel, channel),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async list(
      filters: NotificationListFilters,
    ): Promise<NotificationListResult> {
      const conditions: SQL[] = [];
      if (filters.channel) {
        conditions.push(eq(notifications.channel, filters.channel));
      }
      if (filters.kind) {
        conditions.push(eq(notifications.kind, filters.kind));
      }
      if (filters.status) {
        conditions.push(eq(notifications.status, filters.status));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(notifications)
        .where(where ?? sql`true`)
        .orderBy(desc(notifications.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async markStatus(
      id: string,
      status: NotificationStatus,
      errorMessage: string | null,
    ): Promise<NotificationRow | null> {
      const [updated] = await db
        .update(notifications)
        .set({
          status,
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(notifications.id, id))
        .returning();
      return updated ?? null;
    },
  };
}
