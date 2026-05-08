/**
 * Audit module — public contract.
 *
 * Per ADR-0005, other modules import only what this file re-exports. The
 * audit_log table is generic infrastructure: any module can append a row by
 * calling `auditService.recordEvent({ entityKind, entityId, action, actor,
 * details, reason })`. Reads happen through `auditService.listForEntity`.
 */
export { auditService, AuditServiceImpl } from "./service.js";
export type {
  AuditService,
  ListAuditEventsInput,
  RecordAuditEventInput,
} from "./service.js";
export {
  createAuditRepository,
  type AuditRepository,
  type AuditListFilters,
  type AuditListResult,
} from "./repository.js";
export type {
  AuditActor,
  AuditActorKind,
  AuditEntityKind,
  AuditEvent,
  InventoryAdjustDetails,
  PaginatedAudit,
} from "./types.js";
