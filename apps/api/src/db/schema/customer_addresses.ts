/**
 * Customer addresses — shipping and billing destinations for a customer.
 *
 * Modeling decisions:
 *
 *   - `kind` ('shipping' | 'billing') describes the address's *primary*
 *     intent. Many addresses serve both roles; rather than overload `kind`
 *     to mean "both" or duplicate the row, we let the customer flag a
 *     default-per-kind via two booleans. This means a single address row
 *     can be both the default shipping and the default billing address.
 *
 *   - "At most one default per kind per customer" is enforced by two partial
 *     unique indexes (declared in the migration). Drizzle's schema-time
 *     `uniqueIndex` does not yet model partial predicates well, so the
 *     constraint is in the SQL migration.
 *
 *   - Region FKs (`provinsi_id`, `kota_kabupaten_id`, `kecamatan_id`) are
 *     NOT NULL — these levels are mandatory for any Indonesian address.
 *     `kelurahan_id` is nullable because not every address (e.g. a P.O. box
 *     or a custom landmark) has a kelurahan-level identifier in the BPS data.
 *
 *   - Hierarchy *consistency* (the chosen kota belongs to the chosen
 *     provinsi, etc.) is validated in the service layer, not by FK alone.
 *     A row can satisfy four independent FKs while being internally
 *     inconsistent; the service walks the tree on insert/update.
 *
 *   - `deleted_at` is the soft-delete marker. Addresses are linked to past
 *     orders, so hard-deleting an address would create dangling references
 *     in financial records. Soft delete preserves the historical address
 *     while hiding it from the customer's address book.
 *
 * Indexes:
 *   - `customer_id` for the address-list query.
 *   - Two partial uniques (in the migration) on
 *     `(customer_id) WHERE is_default_shipping` and
 *     `(customer_id) WHERE is_default_billing`.
 */
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { customers } from "./customers.js";
import { kecamatan } from "./kecamatan.js";
import { kelurahan } from "./kelurahan.js";
import { kotaKabupaten } from "./kota_kabupaten.js";
import { provinsi } from "./provinsi.js";

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** "shipping" or "billing"; validated at the HTTP boundary. */
    kind: text("kind").notNull(),
    isDefaultShipping: boolean("is_default_shipping").notNull().default(false),
    isDefaultBilling: boolean("is_default_billing").notNull().default(false),
    recipientName: text("recipient_name").notNull(),
    /** E.164. */
    phone: text("phone").notNull(),
    /** Street and number; the user-facing "Jalan ..." line. */
    addressLine1: text("address_line1").notNull(),
    /** Apartment, RT/RW, landmark — anything that is not the street line. */
    addressLine2: text("address_line2"),
    provinsiId: text("provinsi_id")
      .notNull()
      .references(() => provinsi.id),
    kotaKabupatenId: text("kota_kabupaten_id")
      .notNull()
      .references(() => kotaKabupaten.id),
    kecamatanId: text("kecamatan_id")
      .notNull()
      .references(() => kecamatan.id),
    kelurahanId: text("kelurahan_id").references(() => kelurahan.id),
    /** Five digits; validated at the HTTP boundary. */
    postalCode: text("postal_code").notNull(),
    /** Free-text delivery instructions (e.g. "Titip pak satpam"). */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    customerIdIdx: index("customer_addresses_customer_id_idx").on(
      table.customerId,
    ),
  }),
);

export type CustomerAddressRow = typeof customerAddresses.$inferSelect;
export type NewCustomerAddressRow = typeof customerAddresses.$inferInsert;
