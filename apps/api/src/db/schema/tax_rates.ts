/**
 * Tax rates — operator-managed tax codes (e.g. Indonesian PPN at 11%).
 *
 * v0.1 keeps this very small: a row per (code, currency), with one row per
 * currency flagged as the default. The cart's `getTotals` looks up the
 * default for the cart's currency at compute time and applies it to the
 * subtotal. Future iterations will add per-region / per-product / per-
 * exemption selection.
 *
 * Storage choices:
 *
 *   - `rate_basis_points` is an integer rather than a numeric/float so the
 *     rate is exact at integer level. 1100 means 11.00%; the application
 *     converts to a fraction (`basis_points / 10000`) at apply-time. This
 *     mirrors the way many tax engines store rates (Stripe, Avalara) and
 *     avoids the float-rounding hazards that would otherwise leak into
 *     monetary math.
 *
 *   - `currency` is denormalized onto the row because tax rates are
 *     currency-scoped: a 5% sales tax for USD and a 11% PPN for IDR are
 *     distinct entries. Looking up "the default rate for cart.currency"
 *     is a single indexed query.
 *
 *   - `is_default` is enforced as "at most one default per currency" via a
 *     partial unique index on `(currency) WHERE is_default = true AND
 *     archived_at IS NULL`. Drizzle does not model partial unique indexes
 *     directly — the constraint lives in the migration. The service layer
 *     additionally serializes the "set default" mutation in a transaction
 *     so two concurrent admin saves cannot race past the predicate.
 *
 *   - `archived_at` is the soft-delete-ish marker. An archived rate stays
 *     readable for audit/historical-order recomputation but never satisfies
 *     `getDefaultRate`. We do NOT hard-delete because past order_intents
 *     may reference the code.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const taxRates = pgTable(
  "tax_rates",
  {
    id: text("id").primaryKey(),
    /**
     * Stable operator-facing code, e.g. "PPN_11". UNIQUE so order_intents
     * and reports can refer to it without an FK round-trip. Treat as a
     * stable identifier — renaming is supported but the old code lives
     * forever in archived rows.
     */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    /**
     * Rate in basis points: 1100 = 11.00%. Range checked at the service
     * boundary; the column itself only enforces "not null". A negative
     * rate is rejected by the Zod schema.
     */
    rateBasisPoints: integer("rate_basis_points").notNull(),
    /** ISO 4217. v0.1 ships with IDR; the application enforces the set. */
    currency: text("currency").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Soft-delete-ish marker; archived rows are excluded from default lookup. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    currencyIdx: index("tax_rates_currency_idx").on(table.currency),
  }),
);

export type TaxRateRow = typeof taxRates.$inferSelect;
export type NewTaxRateRow = typeof taxRates.$inferInsert;
