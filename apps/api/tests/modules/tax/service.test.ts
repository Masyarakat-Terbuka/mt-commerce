/**
 * Tax service — unit tests against an in-memory fake repository.
 *
 * Same pattern as the catalog/cart/checkout service tests: construct
 * `TaxServiceImpl` with a hand-rolled fake that implements the
 * `TaxRateRepository` shape. Lets us pin domain rules (default-uniqueness
 * per currency, archive flips off `is_default`, basis-points → Money
 * conversion, halfEven rounding) without standing up Postgres.
 */
import { describe, expect, it } from "vitest";
import { TaxServiceImpl } from "../../../src/modules/tax/service.js";
import type { TaxRateRepository } from "../../../src/modules/tax/repository.js";
import type {
  NewTaxRateRow,
  TaxRateRow,
} from "../../../src/db/schema/index.js";
import { ConflictError, NotFoundError } from "../../../src/lib/errors.js";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

interface FakeStore {
  rates: Map<string, TaxRateRow>;
  clock: number;
}

function createStore(): FakeStore {
  return { rates: new Map(), clock: 0 };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

function createFakeRepo(store: FakeStore): TaxRateRepository {
  const repo: TaxRateRepository = {
    async insertRate(row: NewTaxRateRow): Promise<TaxRateRow> {
      // Mirror the partial unique index: if `is_default = true` for the
      // same currency among non-archived rows, throw a Postgres-style
      // unique violation (the service catches and reclassifies; we don't
      // simulate that here, but the test for "create with isDefault"
      // exercises the clear-then-set path).
      const now = tick(store);
      const r: TaxRateRow = {
        id: row.id,
        code: row.code,
        name: row.name,
        rateBasisPoints: row.rateBasisPoints,
        currency: row.currency,
        isDefault: row.isDefault ?? false,
        createdAt: now,
        updatedAt: now,
        archivedAt: row.archivedAt ?? null,
      };
      store.rates.set(r.id, r);
      return r;
    },
    async getRateById(id) {
      return store.rates.get(id) ?? null;
    },
    async getRateByCode(code) {
      for (const r of store.rates.values()) if (r.code === code) return r;
      return null;
    },
    async getDefaultRate(currency) {
      for (const r of store.rates.values()) {
        if (
          r.currency === currency &&
          r.isDefault &&
          r.archivedAt === null
        ) {
          return r;
        }
      }
      return null;
    },
    async listRates({ activeOnly }) {
      const rows = [...store.rates.values()].filter((r) =>
        activeOnly ? r.archivedAt === null : true,
      );
      rows.sort((a, b) =>
        a.currency === b.currency
          ? a.code.localeCompare(b.code)
          : a.currency.localeCompare(b.currency),
      );
      return rows;
    },
    async updateRate(id, patch) {
      const existing = store.rates.get(id);
      if (!existing) return null;
      const updated: TaxRateRow = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rateBasisPoints !== undefined
          ? { rateBasisPoints: patch.rateBasisPoints }
          : {}),
        ...(patch.isDefault !== undefined
          ? { isDefault: patch.isDefault }
          : {}),
        ...(patch.archivedAt !== undefined
          ? { archivedAt: patch.archivedAt as Date | null }
          : {}),
        updatedAt: tick(store),
      };
      store.rates.set(id, updated);
      return updated;
    },
    async clearDefaultsForCurrency(currency) {
      for (const r of store.rates.values()) {
        if (
          r.currency === currency &&
          r.isDefault &&
          r.archivedAt === null
        ) {
          store.rates.set(r.id, {
            ...r,
            isDefault: false,
            updatedAt: tick(store),
          });
        }
      }
    },
    async withTransaction(fn) {
      // No real transactional semantics in the fake; the production
      // partial unique index is the load-bearing guarantee. The service
      // tests pin that the application clear-then-set sequence runs in
      // the right order.
      return fn(repo);
    },
  };
  return repo;
}

function buildService(): {
  service: TaxServiceImpl;
  store: FakeStore;
} {
  const store = createStore();
  return { service: new TaxServiceImpl(createFakeRepo(store)), store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaxService.createRate", () => {
  it("creates a non-default rate with a generated tax_-prefixed id", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "Pajak Pertambahan Nilai 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: false,
    });
    expect(rate.id).toMatch(/^tax_/);
    expect(rate.code).toBe("PPN_11");
    expect(rate.rateBasisPoints).toBe(1100);
    expect(rate.isDefault).toBe(false);
  });

  it("creates a default rate and sets it as the currency's default", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    expect(rate.isDefault).toBe(true);
    const found = await service.getDefaultRate("IDR");
    expect(found?.id).toBe(rate.id);
  });

  it("rejects a duplicate code with ConflictError", async () => {
    const { service } = buildService();
    await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: false,
    });
    await expect(
      service.createRate({
        code: "PPN_11",
        name: "PPN 11% v2",
        rateBasisPoints: 1100,
        currency: "IDR",
        isDefault: false,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("flips the previous default off when a new default is created", async () => {
    const { service } = buildService();
    const a = await service.createRate({
      code: "PPN_10",
      name: "PPN 10%",
      rateBasisPoints: 1000,
      currency: "IDR",
      isDefault: true,
    });
    const b = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    // Re-fetch a — it should no longer be default.
    const aAfter = await service.getRateById(a.id);
    expect(aAfter?.isDefault).toBe(false);
    expect(b.isDefault).toBe(true);
    // The lookup confirms only one default per currency.
    const def = await service.getDefaultRate("IDR");
    expect(def?.id).toBe(b.id);
  });

  it("isolates defaults per currency", async () => {
    const { service } = buildService();
    const idr = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    const usd = await service.createRate({
      code: "US_SALES_TAX",
      name: "US Sales Tax 5%",
      rateBasisPoints: 500,
      currency: "USD",
      isDefault: true,
    });
    expect(idr.isDefault).toBe(true);
    expect(usd.isDefault).toBe(true);
    expect((await service.getDefaultRate("IDR"))?.id).toBe(idr.id);
    expect((await service.getDefaultRate("USD"))?.id).toBe(usd.id);
  });
});

describe("TaxService.updateRate", () => {
  it("updates name and basis points without changing default", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    const updated = await service.updateRate(rate.id, {
      name: "Pajak Pertambahan Nilai 11%",
      rateBasisPoints: 1100,
    });
    expect(updated.name).toBe("Pajak Pertambahan Nilai 11%");
    expect(updated.isDefault).toBe(true);
  });

  it("flipping isDefault: true clears the previous default atomically", async () => {
    const { service } = buildService();
    const a = await service.createRate({
      code: "PPN_10",
      name: "PPN 10%",
      rateBasisPoints: 1000,
      currency: "IDR",
      isDefault: true,
    });
    const b = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: false,
    });
    const flipped = await service.updateRate(b.id, { isDefault: true });
    expect(flipped.isDefault).toBe(true);
    expect((await service.getRateById(a.id))?.isDefault).toBe(false);
  });

  it("rejects updates on archived rates with ConflictError", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    await service.archiveRate(rate.id);
    await expect(
      service.updateRate(rate.id, { name: "renamed" }),
    ).rejects.toThrow(ConflictError);
  });

  it("404s on a missing id", async () => {
    const { service } = buildService();
    await expect(
      service.updateRate("tax_missing", { name: "x" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("TaxService.archiveRate", () => {
  it("clears is_default and sets archived_at", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    const archived = await service.archiveRate(rate.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.isDefault).toBe(false);
    // No default for IDR after archive.
    expect(await service.getDefaultRate("IDR")).toBeNull();
  });

  it("is idempotent on an already-archived rate", async () => {
    const { service } = buildService();
    const rate = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: false,
    });
    const a = await service.archiveRate(rate.id);
    const b = await service.archiveRate(rate.id);
    expect(a.archivedAt?.getTime()).toBe(b.archivedAt?.getTime());
  });
});

describe("TaxService.applyTax — basis points → Money", () => {
  // The applied math uses Money.multiply(amount, basisPoints/10000, halfEven).
  // We pin the same edge cases the cart totals test pins so the two
  // surfaces stay consistent.
  function rate(basisPoints: number, currency = "IDR") {
    return {
      id: "tax_t",
      code: "PPN",
      name: "PPN",
      rateBasisPoints: basisPoints,
      currency,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    };
  }

  it("Rp 100.000 × 11% = Rp 11.000 (no rounding needed)", async () => {
    const { service } = buildService();
    const tax = service.applyTax(
      { amount: 100_000n, currency: "IDR" },
      rate(1100),
    );
    expect(tax.amount).toBe(11_000n);
    expect(tax.currency).toBe("IDR");
  });

  it("Rp 99.999 × 11% rounds to 11_000 under halfEven (remainder past half → up)", async () => {
    const { service } = buildService();
    const tax = service.applyTax(
      { amount: 99_999n, currency: "IDR" },
      rate(1100),
    );
    // 99_999 * 11 = 1_099_989 ; / 100 = 10_999 r 89
    // 2 * 89 = 178 > 100 → round up to 11_000
    expect(tax.amount).toBe(11_000n);
  });

  it("at exact half, halfEven rounds to nearest even", async () => {
    const { service } = buildService();
    // 50 × 0.11 = 5.5 → halfEven → 6 (next even)
    const tax = service.applyTax({ amount: 50n, currency: "IDR" }, rate(1100));
    expect(tax.amount).toBe(6n);
  });

  it("zero rate produces zero tax", async () => {
    const { service } = buildService();
    const tax = service.applyTax(
      { amount: 100_000n, currency: "IDR" },
      rate(0),
    );
    expect(tax.amount).toBe(0n);
  });

  it("preserves the input currency", async () => {
    const { service } = buildService();
    const tax = service.applyTax(
      { amount: 1_000n, currency: "USD" },
      rate(500, "USD"),
    );
    // 1000 * 5 / 100 = 50
    expect(tax).toEqual({ amount: 50n, currency: "USD" });
  });
});

describe("TaxService.listRates", () => {
  it("returns active-only by default and includes archived when asked", async () => {
    const { service } = buildService();
    const a = await service.createRate({
      code: "PPN_10",
      name: "PPN 10%",
      rateBasisPoints: 1000,
      currency: "IDR",
      isDefault: false,
    });
    const b = await service.createRate({
      code: "PPN_11",
      name: "PPN 11%",
      rateBasisPoints: 1100,
      currency: "IDR",
      isDefault: true,
    });
    await service.archiveRate(a.id);

    const active = await service.listRates({ activeOnly: true });
    expect(active.map((r) => r.id)).toEqual([b.id]);

    const all = await service.listRates({ activeOnly: false });
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});
