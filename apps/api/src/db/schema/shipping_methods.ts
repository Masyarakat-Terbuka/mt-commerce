/**
 * Shipping methods — operator-managed delivery options.
 *
 * v0.1 supports a single `provider_kind`: `manual`, where the operator
 * configures a flat rate per method. Future plugin providers (Biteship,
 * JNE direct, etc.) will set `provider_kind = 'plugin'` and resolve rates
 * dynamically from the plugin registry — the same row shape carries both.
 *
 * Storage choices:
 *
 *   - `code` is the stable operator-facing identifier (e.g. "MANUAL_FLAT",
 *     "JNE_REG"). Checkouts and order_intents store the code as a free
 *     text reference; UNIQUE on the column protects against accidental
 *     collisions when two operators add the same method.
 *
 *   - `provider_kind` is `text` rather than a `pgEnum` so a future plugin
 *     can extend the set without a schema migration. The application
 *     narrows the union (`'manual' | 'plugin'`) at the boundary.
 *
 *   - `flat_rate_amount` + `flat_rate_currency` are nullable because they
 *     only apply to manual methods. The migration adds a CHECK that
 *     enforces "manual ⇒ both not null AND amount >= 0". Plugin methods
 *     leave both columns NULL and resolve at quote time.
 *
 *   - `is_active` lets operators take a method offline without deleting
 *     the row (and orphaning historical references). The storefront
 *     listing filters on this; the admin sees archived rows too.
 *
 *   - `deleted_at` is a soft-delete marker. Past order_intents reference
 *     the code, so hard-deleting would orphan the audit trail. We follow
 *     the same pattern used elsewhere in the schema.
 */
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const shippingMethods = pgTable(
  "shipping_methods",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    /** 'manual' | 'plugin' — narrowed at the application boundary. */
    providerKind: text("provider_kind").notNull(),
    flatRateAmount: bigint("flat_rate_amount", { mode: "bigint" }),
    flatRateCurrency: text("flat_rate_currency"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    activeIdx: index("shipping_methods_active_idx").on(table.isActive),
    /**
     * Manual methods MUST carry a flat rate (amount + currency, amount
     * >= 0). Plugin methods MUST leave both null — the migration mirrors
     * this CHECK; we declare it here so the constraint shows up in the
     * generated TS type's metadata.
     */
    manualHasFlatRate: check(
      "shipping_methods_manual_has_flat_rate",
      sql`(
        (${table.providerKind} = 'manual'
          AND ${table.flatRateAmount} IS NOT NULL
          AND ${table.flatRateCurrency} IS NOT NULL
          AND ${table.flatRateAmount} >= 0)
        OR
        (${table.providerKind} = 'plugin'
          AND ${table.flatRateAmount} IS NULL
          AND ${table.flatRateCurrency} IS NULL)
      )`,
    ),
  }),
);

export type ShippingMethodRow = typeof shippingMethods.$inferSelect;
export type NewShippingMethodRow = typeof shippingMethods.$inferInsert;
