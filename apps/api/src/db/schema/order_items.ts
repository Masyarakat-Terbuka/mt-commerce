/**
 * Order line item — captured snapshot of a single line at order time.
 *
 * Why snapshot fields rather than re-resolving from the catalog:
 *
 *   - Catalog price changes after the order is placed must not retroactively
 *     re-price the order. The customer paid X; the order shows X forever.
 *   - The variant title (and product title) live in `translations` JSONB on
 *     `product_variants` / `products`. We capture the FULL translations
 *     object so the order can be rendered in any of the captured locales
 *     even if the catalog row's translations were edited or the variant
 *     was deleted (per ADR-0010 — snapshots are translation-aware). The
 *     `mappers.ts` layer resolves the requested locale at read time.
 *
 * FK semantics:
 *   - `order_id` cascades on order delete. Orders are not hard-deleted in
 *     practice (financial records are immutable per ARCHITECTURE.md), so
 *     the cascade is defense-in-depth.
 *   - `variant_id` is NO ACTION — variant lifecycle is decoupled from
 *     orders. Soft-deleting or hard-deleting a variant must NOT silently
 *     mutate or orphan an order; the FK keeps the link readable as long
 *     as the variant row exists, and the snapshot fields keep the order
 *     renderable even if it does not.
 */
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./orders.js";
import { productVariants } from "./product_variants.js";

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id),
    /** Captured SKU — survives variant rename/deletion. */
    sku: text("sku").notNull(),
    /**
     * Translation-aware title snapshot. Per ADR-0010 the JSONB shape is
     * `{ "<locale>": { title?: string } }`. Both product- and variant-level
     * translations are merged at write time so the order rendering does
     * not require re-joining catalog tables.
     */
    titleTranslations: jsonb("title_translations").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceAmount: bigint("unit_price_amount", { mode: "bigint" }).notNull(),
    unitPriceCurrency: text("unit_price_currency").notNull(),
    /** `unit_price * quantity`. Stored to avoid recomputing in every read. */
    lineSubtotalAmount: bigint("line_subtotal_amount", {
      mode: "bigint",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderIdx: index("order_items_order_id_idx").on(table.orderId),
    variantIdx: index("order_items_variant_id_idx").on(table.variantId),
    quantityPositive: check(
      "order_items_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
  }),
);

export type OrderItemRow = typeof orderItems.$inferSelect;
export type NewOrderItemRow = typeof orderItems.$inferInsert;
