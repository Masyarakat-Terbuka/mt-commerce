# ADR-0011: Single audit_log table and a generic audit module

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

A handful of v0.1 modules have audit obligations that look the same from a distance: an inventory adjustment, a payment capture, a fulfillment status change, and a future auth account-lockout each want to record *who* did *what* to *which entity* at *what time*, with a small payload of action-specific detail. The orders module already has its own purpose-shaped table (`order_status_history`) with strongly-typed `from_status`/`to_status` columns. Everything else needs an audit trail too.

There are several ways to model this:

**Per-module audit tables.** Each module owns its log: `inventory_history`, `payment_history`, `fulfillment_history`, etc. Strong types per domain, but every new module needing an audit log adds a migration, and "show me everything that changed for entity X across the system" becomes a UNION across N tables.

**Generic key-value audit.** A single table whose payload is wholly opaque jsonb. Easy to write, painful to read — every reader has to know every payload shape.

**Single shared table with a typed application boundary.** One table, generic columns, jsonb for action-specific detail, with the application-side TypeScript narrowing the open columns into typed unions. Modules opt in by writing rows, not by adding schema.

The orders module's `order_status_history` is intentionally separate: orders are the financial record of the platform, and the columnar form makes the per-status counts an indexed scan rather than a jsonb extraction. Everything else has weaker shape pressure and a stronger pull toward a single cross-domain table.

---

## Decision

A single `audit_log` table holds audit events for every module other than orders. A generic `audit` module exposes `recordEvent(...)` and `listForEntity(...)`; modules write rows through that surface and never reach into the table directly.

The columns are deliberately untyped at the database layer:

- `entity_kind` (`text`) — the domain (`inventory`, `payment`, `fulfillment`, `auth`, `catalog`, ...).
- `entity_id` (`text`) — the id of the row that changed; format varies per domain.
- `action` (`text`) — the specific change (`inventory_adjust`, `payment_capture`, `fulfillment_mark_shipped`, ...).
- `actor_kind` (`text`) — `system`, `staff`, or `customer`.
- `actor_id` (`text`, nullable) — the auth user id for staff actors; null otherwise.
- `details` (`jsonb`) — per-action payload.
- `reason` (`text`, nullable) — operator-supplied free text.
- `created_at` (`timestamptz`).

A composite index `(entity_kind, entity_id, created_at)` serves the only read pattern v0.1 cares about: "list events for entity X over time."

---

## Consequences

### Positive

A new module starts writing audit rows without a schema change. The application narrows `entity_kind` and `action` into typed unions (`AuditEntityKind`, the per-action `details` interfaces) so callers get type safety on the way in, while the database accepts a string and never crashes a row mapper on a value it doesn't recognise.

Cross-domain reads are one table scan. "Show me everything that touched payment `pay_abc`" is a single query. The composite index covers the hot-path lookup and the bounded reverse-time pagination.

The audit insert can join the originating module's transaction. `recordEvent` accepts an optional repo override, so an inventory adjustment writes the inventory row and the audit row in one unit of work — partial failure cannot leave audit and reality out of sync. Modules that don't need that strictness (the payments service treats audit as best-effort and logs on failure) get the default singleton.

`actor_id` has no foreign key. Staff accounts can be deleted; their audit trail must outlive them. A FK with `ON DELETE SET NULL` would technically work, but it would also let an operator "clean up" old staff and quietly lose the actor on past actions. Keeping the column referentially loose makes the trail authoritative.

### Negative

Querying by action is a `text` predicate, not an enum check. Postgres handles this fine at our scale, and `entity_kind` filters most queries down to a small slice anyway.

Two writers picking the same `action` string for different things would conflict at the read layer (the application would mix them up). This is a discipline problem managed in code review — the `action` constants per module live next to the writes that use them.

A genuinely massive audit log eventually wants partitioning, archival, and hot/cold storage. v0.1 has none of that. We accept the table will grow and revisit when there is real evidence that a single table is becoming a problem.

---

## What this module does NOT do

- **Retention or archival.** Rows are kept forever. A future job can move old rows to cold storage; the module has no opinion on when.
- **Search beyond entity-key.** There is no full-text search and no jsonb-path index. Querying by `details` requires a full scan, which is fine at v0.1 scale and will be addressed when it isn't.
- **Real-time streaming.** No fanout to an event bus, no SSE feed for the admin. The audit log is a destination, not a source.
- **Mutation.** Rows are append-only. There is no `update_audit_event` or `delete_audit_event` surface.

---

## Alternatives considered

### Per-module audit tables

The orders module already has one (`order_status_history`), so the precedent exists. The reason that pattern works for orders and not for the rest is that orders' state machine is small, fixed, and read-heavy — strongly-typed columns let admin filters ("orders that flipped to paid this week") run as a clean indexed query.

For inventory, payments, fulfillment, and auth, the read pattern is "show me the trail for entity X," not "count by action across time." A per-module table buys nothing for that pattern and costs a migration per domain. Rejected.

### Generic key-value audit with no module-side narrowing

A `Record<string, unknown>` everywhere would mean every reader has to know every payload. The TypeScript union (`AuditEntityKind`, the per-action `details` interfaces) costs nothing at runtime and makes the call sites self-documenting. Rejected.

### `pgEnum` for `entity_kind` and `action`

A new module's first audit row would require a `ALTER TYPE ... ADD VALUE`, a migration, and a deploy. The whole point of having the audit module is to lower that bar. `text` plus a typed boundary keeps the database flexible and the application type-safe. Rejected.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module ownership and bounded contexts. The audit module is shared infrastructure that other modules write to; it does not reach into them.
- `apps/api/src/db/schema/audit_log.ts` — the table.
- `apps/api/src/modules/audit/` — the service surface.
- `apps/api/src/db/schema/order_status_history.ts` — the per-domain audit table that pre-dates this one and remains.
