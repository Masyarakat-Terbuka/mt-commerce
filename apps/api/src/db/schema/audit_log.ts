/**
 * Generic audit log — append-only trail of state changes across modules.
 *
 * Per ARCHITECTURE.md ("Audit and soft deletes") financial entities keep an
 * audit log. The orders module already has its own purpose-shaped
 * `order_status_history`; this `audit_log` is the general-purpose table for
 * everything else (inventory adjustments first, with payments/auth/etc. to
 * follow). Keeping this generic — rather than cloning a per-domain log per
 * module — means a future "show me everything that changed for entity X"
 * query has a single table to scan, and new modules opt in by writing rows
 * instead of by adding schema.
 *
 * Field notes:
 *   - `entity_kind` identifies the domain (e.g. `inventory`, `payment`).
 *     Stored as `text` rather than a `pgEnum` so a new module can append a
 *     new value with no migration. The application narrows to a typed
 *     union (`AuditEntityKind`) at the boundary.
 *   - `entity_id` is the id of the row that changed (variant id for
 *     inventory adjustments, order id for order-side audits, etc.). It is
 *     plain `text` because the id format varies per domain.
 *   - `action` names the specific change (e.g. `inventory_adjust`,
 *     `payment_capture`). Like `entity_kind`, this is `text` for forward
 *     compatibility.
 *   - `actor_kind` separates the three legitimate origins for a change:
 *       - `system`   — automated (job, webhook).
 *       - `staff`    — admin operator. `actor_id` carries the auth_user_id.
 *       - `customer` — buyer-driven (rare for audit, but the union is
 *         shared with `OrderActorKind` for consistency).
 *   - `actor_id` is the auth_user_id of a `staff` actor or null otherwise.
 *     We deliberately do NOT add a FK to `auth_user` — staff accounts can
 *     be deleted, but their audit trail must outlive them.
 *   - `details` is the per-action payload (e.g. `{ deltaApplied, before,
 *     after }` for inventory). `jsonb` so we can carry whatever shape the
 *     action calls for without proliferating columns. Not indexed — the
 *     primary access pattern is "list events for entity X over time."
 *   - `reason` is a free-form operator note. Optional. Capped at 500 chars
 *     at the application boundary; the column is `text` so we do not have
 *     to migrate to widen it later.
 *   - `created_at` is the event time. Default `now()` keeps inserts brief.
 *
 * Indexes:
 *   - `(entity_kind, entity_id, created_at DESC)` — the hot path is "show
 *     me the audit history for this entity, newest first." A single
 *     composite index serves both the "all events for entity X" query and
 *     the bounded paginated reverse-time scan.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    details: jsonb("details").notNull().default({}),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    entityIdx: index("audit_log_entity_idx").on(
      table.entityKind,
      table.entityId,
      table.createdAt,
    ),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
