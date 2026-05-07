/**
 * Junction table: many-to-many between products and categories. The composite
 * primary key prevents duplicate (product, category) pairs without a separate
 * unique constraint.
 *
 * Both sides cascade on delete so the link disappears when either anchor is
 * removed.
 */
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { categories } from "./categories.js";
import { products } from "./products.js";

export const productCategories = pgTable(
  "product_categories",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.productId, table.categoryId] }),
  }),
);

export type ProductCategoryRow = typeof productCategories.$inferSelect;
export type NewProductCategoryRow = typeof productCategories.$inferInsert;
