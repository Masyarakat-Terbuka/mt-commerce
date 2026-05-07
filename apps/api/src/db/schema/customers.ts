/**
 * Customers — natural-person or company buyers. Mirrors the catalog module's
 * shape (ULID id, soft-delete column, timezone-aware timestamps) so that
 * cross-module reasoning stays consistent.
 *
 * Identity & auth contract:
 *   - Identity is owned here. Every customer has a `cust_`-prefixed ULID.
 *   - Authentication is owned by the auth module (Better Auth's `user` table).
 *     The link is `auth_user_id text NULL` — nullable because:
 *       (a) Guest checkout is a first-class flow; a customer record can exist
 *           without an account.
 *       (b) Track A (auth) lands in parallel; until both tracks are merged,
 *           we cannot declare an FK constraint to a table that may not exist.
 *           A follow-up migration will add the FK once both modules are in.
 *   - Email uniqueness is enforced *here* (one email = one customer record).
 *     Trade-off: this collapses guest-checkout-with-email-X and registered-
 *     customer-with-email-X into the same row. The alternative — allowing
 *     duplicate guest rows — would require de-duplicating at order time and
 *     leak orphan rows when shoppers register later. We accept the tighter
 *     constraint and let the customer service "promote" a guest record by
 *     setting `auth_user_id` once the shopper signs up.
 *
 * Indexing:
 *   - `email` is unique (lookup-by-email is the auth and reconciliation path).
 *   - `auth_user_id` carries an index because the storefront's "who am I"
 *     resolution goes auth-user → customer on every authenticated request.
 *   - `deleted_at` is nullable; partial indexes can be added when soft-deleted
 *     volume is large enough to matter (not at v0.1).
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    /**
     * FK target: Better Auth's `user.id` table (text ULID-shaped). The FK
     * constraint is intentionally OMITTED in the initial migration; see the
     * file-header comment for the rationale.
     */
    authUserId: text("auth_user_id"),
    /**
     * Email is unique platform-wide. See the file header for the trade-off
     * with guest checkouts.
     */
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    /** E.164 (e.g. `+628123456789`). Validated at the HTTP boundary. */
    phone: text("phone"),
    /** Indonesian NPWP for B2B invoicing. Plain text; no checksum here. */
    taxIdentifier: text("tax_identifier"),
    companyName: text("company_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    authUserIdIdx: index("customers_auth_user_id_idx").on(table.authUserId),
  }),
);

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomerRow = typeof customers.$inferInsert;
