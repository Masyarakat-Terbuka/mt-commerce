/**
 * Audit service — the cross-module surface for writing and reading audit rows.
 *
 * Other modules use `auditService.recordEvent({ ... })` to append. The helper
 * generates the `aud_…` id, narrows the actor descriptor into the
 * `(actor_kind, actor_id)` row pair, and persists. When the caller is already
 * inside a `db.transaction(...)`, they pass `repo: createAuditRepository(tx)`
 * so the audit insert lands in the same unit of work as the change it
 * describes — partial failure cannot leave audit and reality out of sync.
 *
 * Reads go through `listForEntity` for the "show me the audit history of
 * entity X" pattern. Pagination is offset-based to match the rest of v0.1;
 * a future cursor variant can be added without breaking this surface.
 */
import { id } from "@mt-commerce/core/ulid";
import type { AuditLogRow } from "../../db/schema/index.js";
import {
  createAuditRepository,
  type AuditRepository,
} from "./repository.js";
import type {
  AuditActor,
  AuditEntityKind,
  AuditEvent,
  PaginatedAudit,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface RecordAuditEventInput {
  entityKind: AuditEntityKind | string;
  entityId: string;
  action: string;
  actor: AuditActor;
  details?: Record<string, unknown>;
  reason?: string | null;
  /**
   * Optional repository override so the caller can attach the insert to an
   * in-flight transaction. When omitted the default singleton (auto-commit)
   * is used.
   */
  repo?: AuditRepository;
}

export interface ListAuditEventsInput {
  entityKind: AuditEntityKind | string;
  entityId: string;
  page?: number;
  pageSize?: number;
}

export interface AuditService {
  recordEvent(input: RecordAuditEventInput): Promise<AuditEvent>;
  listForEntity(input: ListAuditEventsInput): Promise<PaginatedAudit>;
}

export class AuditServiceImpl implements AuditService {
  constructor(private readonly defaultRepo: AuditRepository) {}

  async recordEvent(input: RecordAuditEventInput): Promise<AuditEvent> {
    const repo = input.repo ?? this.defaultRepo;
    const auditId = id("aud");
    const { actorKind, actorId } = resolveActor(input.actor);
    const row = await repo.insertEvent({
      id: auditId,
      entityKind: input.entityKind,
      entityId: input.entityId,
      action: input.action,
      actorKind,
      actorId,
      details: (input.details ?? {}) as Record<string, unknown>,
      // Fold an empty/whitespace-only reason to null so a NULL column means
      // "no reason supplied" — saves callers from sending `""` accidentally.
      reason: normalizeReason(input.reason),
    });
    return toAuditEvent(row);
  }

  async listForEntity(input: ListAuditEventsInput): Promise<PaginatedAudit> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const result = await this.defaultRepo.listForEntity({
      entityKind: input.entityKind,
      entityId: input.entityId,
      page,
      pageSize,
    });
    return {
      data: result.rows.map(toAuditEvent),
      total: result.total,
      page,
      pageSize,
    };
  }
}

function resolveActor(actor: AuditActor): {
  actorKind: AuditEvent["actorKind"];
  actorId: string | null;
} {
  switch (actor.kind) {
    case "system":
      return { actorKind: "system", actorId: null };
    case "staff":
      return { actorKind: "staff", actorId: actor.userId };
    case "customer":
      return { actorKind: "customer", actorId: actor.customerId ?? null };
  }
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function clampPage(value: number | undefined): number {
  if (!value || value < 1) return 1;
  return Math.floor(value);
}

function clampPageSize(value: number | undefined): number {
  if (!value || value < 1) return DEFAULT_PAGE_SIZE;
  if (value > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(value);
}

/**
 * Drizzle row → domain `AuditEvent`. `details` is `unknown` from the DB
 * driver; we cast back to `Record<string, unknown>` because the persistence
 * shape always lands as a JSON object (the helper rejects non-objects on
 * write). Defensive narrowing here would only mask write-side bugs.
 */
function toAuditEvent(row: AuditLogRow): AuditEvent {
  return {
    id: row.id,
    entityKind: row.entityKind,
    entityId: row.entityId,
    action: row.action,
    actorKind: row.actorKind as AuditEvent["actorKind"],
    actorId: row.actorId,
    details: (row.details ?? {}) as Record<string, unknown>,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** Default singleton wired to the runtime database. */
export const auditService: AuditService = new AuditServiceImpl(
  createAuditRepository(),
);
