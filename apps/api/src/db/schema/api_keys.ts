/**
 * API keys — long-lived bearer credentials for external services
 * (e.g. Midtrans webhook callbacks, future SDK consumers needing direct
 * machine-to-machine access). Per SECURITY.md, the plaintext key is shown
 * exactly once at creation; the database stores only an Argon2id hash.
 *
 * Schema notes:
 *   - `id` uses the `apik_` prefix (typed ULID via the core helper). It is
 *     the key identifier the caller knows; the bearer header carries
 *     `<id>.<secret>` so server lookup is O(1) on the row.
 *   - `key_hash` is the Argon2id hash of the bearer's secret half. Hashing on
 *     every authenticated request is intentionally expensive — the cost is
 *     paid per request because we never store the plaintext to compare with.
 *   - `scopes` is `text[]`. Membership is checked at the route boundary by
 *     `requireScope("...")`. Starter set is documented in the module README.
 *   - `revoked_at` is a soft revocation marker. Hard delete is allowed but
 *     the soft path lets operators see who used what when investigating
 *     incidents.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references((): AnyPgColumn => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Argon2id hash of the bearer's secret half. Never plaintext. */
  keyHash: text("key_hash").notNull(),
  /**
   * Scope strings such as `catalog:read`, `catalog:write`, `webhooks:receive`.
   * Postgres `text[]` rather than a join table because membership is a
   * simple set check and the cardinality per key is small.
   */
  scopes: text("scopes")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  /** Soft revocation. A non-NULL value disables the key. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
