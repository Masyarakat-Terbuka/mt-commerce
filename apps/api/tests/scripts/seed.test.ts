/**
 * Sanity tests for the dev seed scripts.
 *
 * Both seeds are normally exercised interactively (the value of the seed
 * IS that a developer sees data in the UI a moment later), so the unit
 * coverage here is intentionally light: we assert the static shape and
 * that the seed completes against a small in-memory fake of the Drizzle
 * client. The fake mirrors only the surface the seeds use:
 *
 *   - `db.insert(table).values(rows).onConflictDoNothing(...).returning(...)`
 *   - `db.insert(table).values(row)` (no conflict, no returning)
 *   - `db.select({...}).from(table).where(eq(col, val)).limit(n)`
 *
 * That keeps the fake under 100 lines and avoids re-implementing Drizzle's
 * type-level magic. Anything beyond that scope (cross-table joins, sql``
 * fragments) belongs in an integration test against a real Postgres.
 */
import { describe, expect, it, vi } from "vitest";

// Mock drizzle-orm BEFORE importing the seed modules so they pick up our
// EqCondition-returning `eq`. Real drizzle's `eq` returns an opaque SQL
// node; for the in-memory fake we want a plain shape we can introspect
// in `where()`. We re-export everything else (`and`, `sql`, etc.) from
// the actual module so unrelated imports keep working.
vi.mock("drizzle-orm", async (importOriginal) => {
  // `importOriginal<typeof import(...)>()` is vitest's idiomatic way to
  // type the unmocked module — switching to a top-level type import would
  // pull the real module's types eagerly and defeat the lazy resolution.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({
      __eq: true as const,
      column,
      value,
    }),
  };
});

import {
  __seedDataForTesting as catalogSeedData,
  seedDemoCatalog,
} from "../../src/modules/catalog/seed/demo-catalog.js";
import {
  __seedDataForTesting as regionsSeedData,
  seedRegions,
} from "../../src/modules/customer/seed/regions.js";
import {
  categories,
  inventoryLevels,
  kecamatan,
  kelurahan,
  kotaKabupaten,
  productCategories,
  productVariants,
  products,
  provinsi,
} from "../../src/db/schema/index.js";

// ---------------------------------------------------------------------------
// Minimal Drizzle-shaped fake
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

interface ConflictRule {
  /** Drizzle column object to dedupe on. Compared by reference. */
  target: unknown;
}

/**
 * Captures one `eq(col, value)` predicate. The seeds only ever select by
 * a single equality, so we do not bother modeling `and`/`or`/`sql`.
 */
interface EqCondition {
  __eq: true;
  column: unknown;
  value: unknown;
}

function isEqCondition(value: unknown): value is EqCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __eq?: unknown }).__eq === true
  );
}

/**
 * Fake builder. Each chained call returns either `this` (to keep the
 * chain) or, for terminal `.returning()`/`.where().limit()`, the resolved
 * rows wrapped in a thenable so `await` works.
 */
class FakeStore {
  // Each table is keyed by reference — the actual Drizzle table objects
  // imported from the schema. That avoids a name-string registry and
  // keeps assertions tied to the same identity the seed code uses.
  private readonly tables = new Map<unknown, AnyRow[]>();

  rowsFor(table: unknown): readonly AnyRow[] {
    return this.tables.get(table) ?? [];
  }

  insert(table: unknown) {
    // `store` aliases `this` so the inner object literal — which acts as
    // Drizzle's chained query builder — can reach the FakeDb instance from
    // its method bodies. `this` inside those methods refers to the
    // builder object, not the class.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    let pendingRows: AnyRow[] = [];
    let conflict: ConflictRule | undefined;
    const builder = {
      values(rowOrRows: AnyRow | AnyRow[]) {
        pendingRows = Array.isArray(rowOrRows) ? [...rowOrRows] : [rowOrRows];
        return this;
      },
      onConflictDoNothing(rule?: ConflictRule) {
        conflict = rule;
        return this;
      },
      returning(_columns?: Record<string, unknown>) {
        return store.commitInsert(table, pendingRows, conflict);
      },
      // `await` on the bare insert chain (no .returning()) — used for
      // inventory level inserts where we don't need ids back.
      then<T1 = void, T2 = never>(
        onfulfilled?: ((value: void) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        store.commitInsert(table, pendingRows, conflict);
        return Promise.resolve().then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  /**
   * Apply ON CONFLICT semantics. We support two cases the seeds use:
   *   - target = single column object → dedupe on that column's value.
   *   - target = undefined (catch-all) → dedupe on the table's known
   *     uniqueness key. The seeds use this only for the
   *     product_categories junction, which has a composite PK, so we
   *     special-case it by checking (productId, categoryId) tuples.
   */
  private commitInsert(
    table: unknown,
    rows: AnyRow[],
    conflict: ConflictRule | undefined,
  ): AnyRow[] {
    const existing = this.tables.get(table) ?? [];
    const inserted: AnyRow[] = [];
    for (const row of rows) {
      let conflicts = false;
      if (conflict) {
        const colKey = columnNameOf(conflict.target);
        if (colKey !== undefined) {
          conflicts = existing.some((r) => r[colKey] === row[colKey]);
        }
      } else if (table === productCategories) {
        conflicts = existing.some(
          (r) =>
            r.productId === row.productId && r.categoryId === row.categoryId,
        );
      }
      if (!conflicts) {
        existing.push(row);
        inserted.push(row);
      }
    }
    this.tables.set(table, existing);
    return inserted;
  }

  select(_columns?: Record<string, unknown>) {
    // See comment on `insert` above — same reason.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    let currentTable: unknown;
    let predicate: EqCondition | undefined;
    const builder = {
      from(table: unknown) {
        currentTable = table;
        return this;
      },
      where(condition: unknown) {
        if (isEqCondition(condition)) predicate = condition;
        return this;
      },
      async limit(_n: number) {
        const rows = store.tables.get(currentTable) ?? [];
        if (!predicate) return rows;
        const colKey = columnNameOf(predicate.column);
        if (colKey === undefined) return rows;
        return rows.filter((r) => r[colKey] === predicate?.value);
      },
    };
    return builder;
  }
}

/**
 * Extract the JS property name from a Drizzle column. Drizzle column
 * objects expose their schema name on the `name` property; we fall back
 * to scanning the schema tables to find the JS-side key matching that
 * column object by identity.
 */
function columnNameOf(column: unknown): string | undefined {
  if (
    typeof column === "object" &&
    column !== null &&
    typeof (column as { name?: unknown }).name === "string"
  ) {
    // Find the JS-side key name on whichever table this column belongs to.
    for (const table of [
      provinsi,
      kotaKabupaten,
      kecamatan,
      kelurahan,
      categories,
      products,
      productVariants,
      inventoryLevels,
      productCategories,
    ] as const) {
      for (const [jsKey, value] of Object.entries(table)) {
        if (value === column) return jsKey;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedRegions", () => {
  it("has the dataset shape the docs promise", () => {
    expect(regionsSeedData.provinsi).toHaveLength(3);
    expect(regionsSeedData.kotaKabupaten).toHaveLength(5);
    expect(regionsSeedData.kecamatan).toHaveLength(8);
    expect(regionsSeedData.kelurahan).toHaveLength(12);
  });

  it("uses real BPS codes that descend correctly", () => {
    // Every kota's provinsi_id must be a known provinsi.
    const provIds = new Set(regionsSeedData.provinsi.map((p) => p.id));
    for (const k of regionsSeedData.kotaKabupaten) {
      expect(provIds.has(k.provinsiId)).toBe(true);
    }
    // Every kecamatan's kota_kabupaten_id must be a known kota.
    const kotaIds = new Set(regionsSeedData.kotaKabupaten.map((k) => k.id));
    for (const kc of regionsSeedData.kecamatan) {
      expect(kotaIds.has(kc.kotaKabupatenId)).toBe(true);
    }
    // Every kelurahan's kecamatan_id must be a known kecamatan.
    const kecIds = new Set(regionsSeedData.kecamatan.map((k) => k.id));
    for (const kl of regionsSeedData.kelurahan) {
      expect(kecIds.has(kl.kecamatanId)).toBe(true);
    }
  });

  it("uses five-digit numeric postal codes", () => {
    for (const kl of regionsSeedData.kelurahan) {
      expect(kl.postalCode).toMatch(/^\d{5}$/);
    }
  });

  it("inserts everything on a fresh store and is a no-op on the second run", async () => {
    const fake = new FakeStore();
    const db = fake as unknown as Parameters<typeof seedRegions>[0];

    const first = await seedRegions(db);
    expect(first.provinsi).toBe(3);
    expect(first.kotaKabupaten).toBe(5);
    expect(first.kecamatan).toBe(8);
    expect(first.kelurahan).toBe(12);
    expect(first.inserted).toEqual({
      provinsi: 3,
      kotaKabupaten: 5,
      kecamatan: 8,
      kelurahan: 12,
    });

    const second = await seedRegions(db);
    expect(second.inserted).toEqual({
      provinsi: 0,
      kotaKabupaten: 0,
      kecamatan: 0,
      kelurahan: 0,
    });
    // The static counts stay the same regardless.
    expect(second.provinsi).toBe(3);
    expect(second.kelurahan).toBe(12);
  });
});

describe("seedDemoCatalog", () => {
  it("has the dataset shape the docs promise", () => {
    expect(catalogSeedData.categories).toHaveLength(5);
    expect(catalogSeedData.products).toHaveLength(6);
    const totalVariants = catalogSeedData.products.reduce(
      (acc, p) => acc + p.variants.length,
      0,
    );
    // 1 + 2 + 3 + 1 + 1 + 2 = 10 variants across the 6 products.
    expect(totalVariants).toBe(10);
  });

  it("prices every variant in IDR whole rupiah", () => {
    for (const p of catalogSeedData.products) {
      for (const v of p.variants) {
        expect(typeof v.priceAmount).toBe("bigint");
        expect(v.priceAmount > 0n).toBe(true);
      }
    }
  });

  it("references only declared category slugs", () => {
    const known = new Set(catalogSeedData.categories.map((c) => c.slug));
    for (const p of catalogSeedData.products) {
      for (const slug of p.categorySlugs) {
        expect(known.has(slug)).toBe(true);
      }
    }
  });

  it("inserts categories, products, variants, inventory, and junctions on first run", async () => {
    const fake = new FakeStore();
    const db = fake as unknown as Parameters<typeof seedDemoCatalog>[0];

    const summary = await seedDemoCatalog(db);
    expect(summary.categories).toBe(5);
    expect(summary.products).toBe(6);
    expect(summary.variants).toBe(10);
    expect(summary.inventoryLevels).toBe(10);
    // Junction rows: kopi=1+1, batik+fashion=2, kerajinan=1+1, kuliner=1
    // → 1+1+2+1+1+1 = 7
    expect(summary.productCategories).toBe(7);
    expect(summary.inserted.categories).toBe(5);
    expect(summary.inserted.products).toBe(6);
    expect(summary.inserted.variants).toBe(10);
    expect(summary.inserted.inventoryLevels).toBe(10);
    expect(summary.inserted.productCategories).toBe(7);

    // Spot-check the store: every product row landed and is active.
    const productRows = fake.rowsFor(products);
    expect(productRows).toHaveLength(6);
    for (const row of productRows) {
      expect(row.status).toBe("active");
      expect(row.defaultCurrency).toBe("IDR");
    }
  });

  it("is a no-op on the second run (idempotent)", async () => {
    const fake = new FakeStore();
    const db = fake as unknown as Parameters<typeof seedDemoCatalog>[0];

    await seedDemoCatalog(db);
    const second = await seedDemoCatalog(db);

    expect(second.inserted).toEqual({
      categories: 0,
      products: 0,
      variants: 0,
      inventoryLevels: 0,
      productCategories: 0,
    });
    // The static counts stay the same regardless.
    expect(second.products).toBe(6);
    expect(second.variants).toBe(10);

    // No duplicate rows anywhere.
    expect(fake.rowsFor(products)).toHaveLength(6);
    expect(fake.rowsFor(productVariants)).toHaveLength(10);
    expect(fake.rowsFor(inventoryLevels)).toHaveLength(10);
    expect(fake.rowsFor(productCategories)).toHaveLength(7);
  });
});
