/**
 * Audit module — domain types.
 *
 * The persisted columns are plain text/jsonb (see
 * `apps/api/src/db/schema/audit_log.ts`) so any module can append a new
 * `entity_kind` or `action` without a schema change. The unions below are the
 * application-side narrowing of those text columns: callers pick from a
 * known set, the database trusts whatever lands.
 */

/**
 * Domain whose state is being audited. New modules append here when they
 * start writing audit rows. The DB column stays `text` so an unknown value
 * read back from the database does not crash a row mapper.
 */
export type AuditEntityKind =
  | "inventory"
  | "order"
  | "payment"
  | "auth"
  | "catalog";

/**
 * Origin of the change. Mirrors `OrderActorKind` in the orders module so the
 * two audit surfaces agree.
 */
export type AuditActorKind = "system" | "staff" | "customer";

/**
 * Actor descriptor passed to `recordAuditEvent`. The helper resolves to the
 * (`actor_kind`, `actor_id`) row pair on insert. `staff` carries the
 * auth-user id; the other two never do.
 */
export type AuditActor =
  | { kind: "system" }
  | { kind: "staff"; userId: string }
  | { kind: "customer"; customerId?: string };

export interface AuditEvent {
  id: string;
  entityKind: string;
  entityId: string;
  action: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  details: Record<string, unknown>;
  reason: string | null;
  createdAt: Date;
}

export interface PaginatedAudit {
  data: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Per-action `details` shape for an inventory adjustment. Documented here so
 * the inventory consumer and the audit reader share one truth, and so the
 * SDK / admin types can mirror it without reverse-engineering the JSONB.
 */
export interface InventoryAdjustDetails {
  /** Signed delta the operator submitted. */
  deltaApplied: number;
  /** Available count before the adjustment. */
  before: number;
  /** Available count after the adjustment. */
  after: number;
}
