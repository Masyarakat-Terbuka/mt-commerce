/**
 * Cart — the shopper's pre-checkout basket.
 *
 * A cart is either a guest cart (`customer_id` IS NULL) or bound to a
 * registered customer. Both flavors live in the same table so the storefront
 * can promote a guest cart into a customer cart by setting `customer_id`
 * once the shopper signs in (via `mergeGuestIntoCustomer` in the service).
 *
 * Single-currency invariant: every cart locks its `currency` at the time of
 * the first item add (the service enforces this). Mixed-currency carts are
 * forbidden because cart totals — and the orders derived from them — must
 * be a single Money value, not a basket of incomparable currencies.
 *
 * Lifecycle:
 *   - `active`     — open, accepting items.
 *   - `abandoned`  — the sweep job (or an admin override) marked it dormant.
 *   - `converted`  — an order was created from this cart. Frozen forever.
 *
 * Every cart carries `expires_at` so a future cleanup job can sweep guest
 * carts that have been idle past the policy. The default is 30 days; the
 * sweep itself is out of scope for this module and will be implemented when
 * BullMQ jobs land.
 *
 * Indexing:
 *   - `(customer_id) WHERE status = 'active'` — supports the storefront's
 *     "current cart for customer X" lookup, which runs on every authenticated
 *     pageview. Partial keeps the index small (most carts are not active).
 *   - `(expires_at)` — supports the cleanup job's "find me carts that have
 *     aged past the policy" scan.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers.js";

export const carts = pgTable(
  "carts",
  {
    id: text("id").primaryKey(),
    /**
     * Nullable for guest carts. The FK uses NO ACTION semantics through the
     * lack of an explicit `onDelete` clause — soft-delete of a customer
     * should not cascade-delete their cart history; admin tooling reconciles
     * any leftover rows explicitly.
     */
    customerId: text("customer_id").references(() => customers.id),
    /** ISO 4217 code. Locked at first item add. */
    currency: text("currency").notNull(),
    /**
     * `text` not `pgEnum` to keep the migration simple and to match the
     * existing pattern used for staff role storage in `staff_profiles` (the
     * enum is enforced at the application boundary via the Zod schema).
     */
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`(now() + interval '30 days')`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Non-partial index on customer_id; the partial index on status='active'
    // is declared in the migration since drizzle-kit does not natively
    // express partial predicates at schema-time.
    customerIdIdx: index("carts_customer_id_idx").on(table.customerId),
    expiresAtIdx: index("carts_expires_at_idx").on(table.expiresAt),
  }),
);

export type CartRow = typeof carts.$inferSelect;
export type NewCartRow = typeof carts.$inferInsert;
