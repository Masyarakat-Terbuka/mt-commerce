/**
 * Idempotency key store — backs the `Idempotency-Key` middleware.
 *
 * Per ARCHITECTURE.md and SECURITY.md, every payment-touching operation is
 * idempotent. The middleware records `(scope+key, request_hash, status,
 * response_body)` after a successful first run and serves the stored
 * response on replay.
 *
 * `key` is the PRIMARY key. The application stores `sha256(scope || ":" ||
 * raw_key)` so a key minted for one scope cannot be reused under another
 * — see `apps/api/src/middleware/idempotency.ts` for the derivation. This
 * keeps the column a fixed-length-ish hex string and makes the partial
 * leak of one route's key list useless against another route.
 *
 * `request_hash` is `sha256(method + path + body)`. On replay with the
 * same scoped key we compare hashes:
 *   - match  → return the stored response.
 *   - differ → 409 `idempotency_key_reuse`.
 *
 * `created_at` carries an index so a future cleanup job can scan by age
 * (TTL is 24 hours per the SECURITY.md commitment; the cleanup job itself
 * is out of scope for this module).
 */
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    /** Stored as `sha256(scope ":" raw)` — see middleware for derivation. */
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    status: integer("status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("idempotency_keys_created_at_idx").on(table.createdAt),
  }),
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
