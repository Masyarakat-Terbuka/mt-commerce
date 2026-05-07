/**
 * Customer repository — Drizzle queries, no domain logic.
 *
 * Mirrors the catalog repository: returns Drizzle row types, leaves DTO
 * shaping to the service. Constructed via `createCustomerRepository(db)` so
 * tests can inject a fake by implementing the `CustomerRepository` shape.
 *
 * The whole repository takes a single `db` reference. Methods that need to
 * run together inside a transaction use `withTransaction(fn)`, which calls
 * `db.transaction()` and re-wraps the inner `tx` as a fresh repository — the
 * service does not need to know about Drizzle types to compose work.
 */
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  customerAddresses,
  customers,
  kecamatan,
  kelurahan,
  kotaKabupaten,
  provinsi,
  type CustomerAddressRow,
  type CustomerRow,
  type KecamatanRow,
  type KelurahanRow,
  type KotaKabupatenRow,
  type NewCustomerAddressRow,
  type NewCustomerRow,
  type ProvinsiRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

/**
 * Escape characters that have special meaning to a Postgres `ILIKE` pattern.
 * Same pattern as the catalog repository — see that file for the rationale.
 */
export function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export interface CustomerListFilters {
  email?: string;
  search?: string;
  /** When set, only customers with `deleted_at IS NULL` are returned. */
  excludeDeleted?: boolean;
  page: number;
  pageSize: number;
}

export interface CustomerListResult {
  rows: CustomerRow[];
  total: number;
}

/**
 * Explicit interface so `withTransaction` can self-reference the repository
 * shape without TypeScript walking into a circularity warning. Tests also
 * implement this interface to stand up an in-memory fake.
 */
export interface CustomerRepository {
  insertCustomer(row: NewCustomerRow): Promise<CustomerRow>;
  getCustomerById(id: string): Promise<CustomerRow | null>;
  getCustomerByEmail(email: string): Promise<CustomerRow | null>;
  getCustomerByAuthUserId(authUserId: string): Promise<CustomerRow | null>;
  listCustomers(filters: CustomerListFilters): Promise<CustomerListResult>;
  updateCustomer(
    id: string,
    patch: Partial<NewCustomerRow>,
  ): Promise<CustomerRow | null>;
  softDeleteCustomer(id: string): Promise<void>;

  insertAddress(row: NewCustomerAddressRow): Promise<CustomerAddressRow>;
  getAddressById(id: string): Promise<CustomerAddressRow | null>;
  listAddressesForCustomer(customerId: string): Promise<CustomerAddressRow[]>;
  updateAddress(
    id: string,
    patch: Partial<NewCustomerAddressRow>,
  ): Promise<CustomerAddressRow | null>;
  softDeleteAddress(id: string): Promise<void>;
  clearDefaultForKind(
    customerId: string,
    kind: "shipping" | "billing",
  ): Promise<void>;
  withTransaction<T>(fn: (tx: CustomerRepository) => Promise<T>): Promise<T>;

  listProvinsi(): Promise<ProvinsiRow[]>;
  getProvinsiById(id: string): Promise<ProvinsiRow | null>;
  listKotaKabupaten(provinsiId: string): Promise<KotaKabupatenRow[]>;
  getKotaKabupatenById(id: string): Promise<KotaKabupatenRow | null>;
  listKecamatan(kotaKabupatenId: string): Promise<KecamatanRow[]>;
  getKecamatanById(id: string): Promise<KecamatanRow | null>;
  listKelurahan(kecamatanId: string): Promise<KelurahanRow[]>;
  getKelurahanById(id: string): Promise<KelurahanRow | null>;
  searchKelurahanByPostalCode(postalCode: string): Promise<KelurahanRow[]>;
}

export function createCustomerRepository(
  db: Db = defaultDb,
): CustomerRepository {
  return {
    // -------------------------------------------------------------------
    // Customers
    // -------------------------------------------------------------------
    async insertCustomer(row: NewCustomerRow): Promise<CustomerRow> {
      const [inserted] = await db.insert(customers).values(row).returning();
      if (!inserted)
        throw new Error("insertCustomer: returning() yielded no rows");
      return inserted;
    },

    async getCustomerById(id: string): Promise<CustomerRow | null> {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      return row ?? null;
    },

    async getCustomerByEmail(email: string): Promise<CustomerRow | null> {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.email, email))
        .limit(1);
      return row ?? null;
    },

    async getCustomerByAuthUserId(
      authUserId: string,
    ): Promise<CustomerRow | null> {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.authUserId, authUserId))
        .limit(1);
      return row ?? null;
    },

    async listCustomers(
      filters: CustomerListFilters,
    ): Promise<CustomerListResult> {
      const conditions: SQL[] = [];
      if (filters.excludeDeleted) {
        conditions.push(isNull(customers.deletedAt));
      }
      if (filters.email) {
        conditions.push(eq(customers.email, filters.email));
      }
      if (filters.search) {
        const safe = escapeLikePattern(filters.search);
        conditions.push(ilike(customers.email, `%${safe}%`));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(customers)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(customers)
        .where(where ?? sql`true`)
        .orderBy(desc(customers.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async updateCustomer(
      id: string,
      patch: Partial<NewCustomerRow>,
    ): Promise<CustomerRow | null> {
      const [updated] = await db
        .update(customers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(customers.id, id))
        .returning();
      return updated ?? null;
    },

    async softDeleteCustomer(id: string): Promise<void> {
      await db
        .update(customers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.id, id));
    },

    // -------------------------------------------------------------------
    // Addresses
    // -------------------------------------------------------------------
    async insertAddress(
      row: NewCustomerAddressRow,
    ): Promise<CustomerAddressRow> {
      const [inserted] = await db
        .insert(customerAddresses)
        .values(row)
        .returning();
      if (!inserted)
        throw new Error("insertAddress: returning() yielded no rows");
      return inserted;
    },

    async getAddressById(id: string): Promise<CustomerAddressRow | null> {
      const [row] = await db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.id, id))
        .limit(1);
      return row ?? null;
    },

    async listAddressesForCustomer(
      customerId: string,
    ): Promise<CustomerAddressRow[]> {
      return db
        .select()
        .from(customerAddresses)
        .where(
          and(
            eq(customerAddresses.customerId, customerId),
            isNull(customerAddresses.deletedAt),
          ),
        )
        .orderBy(desc(customerAddresses.createdAt));
    },

    async updateAddress(
      id: string,
      patch: Partial<NewCustomerAddressRow>,
    ): Promise<CustomerAddressRow | null> {
      const [updated] = await db
        .update(customerAddresses)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(customerAddresses.id, id))
        .returning();
      return updated ?? null;
    },

    async softDeleteAddress(id: string): Promise<void> {
      await db
        .update(customerAddresses)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(customerAddresses.id, id));
    },

    /**
     * Clear the default flag for a given (customer, kind) pair on every
     * non-deleted address. The matching service call wraps this and the
     * subsequent set-on-target-row in a single transaction to satisfy the
     * partial unique index without producing a transient duplicate.
     */
    async clearDefaultForKind(
      customerId: string,
      kind: "shipping" | "billing",
    ): Promise<void> {
      const column =
        kind === "shipping"
          ? customerAddresses.isDefaultShipping
          : customerAddresses.isDefaultBilling;
      await db
        .update(customerAddresses)
        .set(
          kind === "shipping"
            ? { isDefaultShipping: false, updatedAt: new Date() }
            : { isDefaultBilling: false, updatedAt: new Date() },
        )
        .where(
          and(
            eq(customerAddresses.customerId, customerId),
            eq(column, true),
            isNull(customerAddresses.deletedAt),
          ),
        );
    },

    /**
     * Run a unit of work inside a single transaction. The callback receives
     * a repository instance bound to the transactional `tx` so the same
     * methods are available without double-wrapping.
     */
    async withTransaction<T>(
      fn: (tx: CustomerRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createCustomerRepository(tx as unknown as Db)),
      );
    },

    // -------------------------------------------------------------------
    // Regions
    // -------------------------------------------------------------------
    async listProvinsi(): Promise<ProvinsiRow[]> {
      return db.select().from(provinsi).orderBy(asc(provinsi.name));
    },

    async getProvinsiById(id: string): Promise<ProvinsiRow | null> {
      const [row] = await db
        .select()
        .from(provinsi)
        .where(eq(provinsi.id, id))
        .limit(1);
      return row ?? null;
    },

    async listKotaKabupaten(
      provinsiId: string,
    ): Promise<KotaKabupatenRow[]> {
      return db
        .select()
        .from(kotaKabupaten)
        .where(eq(kotaKabupaten.provinsiId, provinsiId))
        .orderBy(asc(kotaKabupaten.name));
    },

    async getKotaKabupatenById(
      id: string,
    ): Promise<KotaKabupatenRow | null> {
      const [row] = await db
        .select()
        .from(kotaKabupaten)
        .where(eq(kotaKabupaten.id, id))
        .limit(1);
      return row ?? null;
    },

    async listKecamatan(kotaKabupatenId: string): Promise<KecamatanRow[]> {
      return db
        .select()
        .from(kecamatan)
        .where(eq(kecamatan.kotaKabupatenId, kotaKabupatenId))
        .orderBy(asc(kecamatan.name));
    },

    async getKecamatanById(id: string): Promise<KecamatanRow | null> {
      const [row] = await db
        .select()
        .from(kecamatan)
        .where(eq(kecamatan.id, id))
        .limit(1);
      return row ?? null;
    },

    async listKelurahan(kecamatanId: string): Promise<KelurahanRow[]> {
      return db
        .select()
        .from(kelurahan)
        .where(eq(kelurahan.kecamatanId, kecamatanId))
        .orderBy(asc(kelurahan.name));
    },

    async getKelurahanById(id: string): Promise<KelurahanRow | null> {
      const [row] = await db
        .select()
        .from(kelurahan)
        .where(eq(kelurahan.id, id))
        .limit(1);
      return row ?? null;
    },

    async searchKelurahanByPostalCode(
      postalCode: string,
    ): Promise<KelurahanRow[]> {
      return db
        .select()
        .from(kelurahan)
        .where(eq(kelurahan.postalCode, postalCode))
        .orderBy(asc(kelurahan.name));
    },
  };
}
