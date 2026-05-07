/**
 * `TaxService` — public contract for the tax module.
 *
 * Owns:
 *   - tax-rate lifecycle (create, update, archive)
 *   - the "exactly one default per currency among non-archived rows"
 *     invariant — enforced atomically via a transaction that clears the
 *     prior default before flipping the new row's `is_default = true`.
 *     The partial unique index on the table (`tax_rates_default_per_-
 *     currency_unique_idx`) is the database-side guarantee against a
 *     concurrent racer slipping past the application check.
 *   - `applyTax(amount, rate)` — pure helper used by the cart's totals
 *     computation. Multiplies the money amount by `basisPoints / 10000`
 *     with halfEven (banker's) rounding per ADR-0007.
 *   - domain errors (NotFoundError, ConflictError, ValidationError) —
 *     never leaks Drizzle/Postgres errors to callers
 *
 * Constructor takes a repository so tests can swap an in-memory fake; the
 * default singleton `taxService` (in `index.ts`) is wired to the runtime
 * `db`.
 */
import { multiply as moneyMultiply, type Money } from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { toTaxRate } from "./mappers.js";
import {
  createTaxRateRepository,
  type TaxRateRepository,
} from "./repository.js";
import type {
  CreateTaxRateInput,
  TaxRate,
  UpdateTaxRateInput,
} from "./types.js";

export interface TaxService {
  // Reads
  listRates(opts?: { activeOnly?: boolean }): Promise<TaxRate[]>;
  getRateById(id: string): Promise<TaxRate | null>;
  getRateByCode(code: string): Promise<TaxRate | null>;
  /**
   * Returns the single default, non-archived rate for a currency, or null.
   * Hot path — called by the cart's `getTotals` on every read. Backed by
   * a partial unique index for O(1) lookup.
   */
  getDefaultRate(currency: string): Promise<TaxRate | null>;

  // Mutations (admin)
  createRate(input: CreateTaxRateInput): Promise<TaxRate>;
  updateRate(id: string, patch: UpdateTaxRateInput): Promise<TaxRate>;
  archiveRate(id: string): Promise<TaxRate>;

  // Pure compute
  /**
   * Apply a rate to a money amount. Pure (no DB I/O); halfEven rounding
   * per ADR-0007.
   *
   * `basisPoints / 10000` is the conversion: 1100 → 0.11. The Money helper
   * already handles the bigint/decimal-string ratio internally, so we
   * pass the ratio as a number and rely on its `toRatio` decomposition
   * to keep the math exact at the integer level.
   */
  applyTax(amount: Money, rate: TaxRate): Money;
}

export class TaxServiceImpl implements TaxService {
  constructor(private readonly repo: TaxRateRepository) {}

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async listRates(opts?: { activeOnly?: boolean }): Promise<TaxRate[]> {
    const rows = await this.repo.listRates({
      activeOnly: opts?.activeOnly ?? true,
    });
    return rows.map(toTaxRate);
  }

  async getRateById(rateId: string): Promise<TaxRate | null> {
    const row = await this.repo.getRateById(rateId);
    return row ? toTaxRate(row) : null;
  }

  async getRateByCode(code: string): Promise<TaxRate | null> {
    const row = await this.repo.getRateByCode(code);
    return row ? toTaxRate(row) : null;
  }

  async getDefaultRate(currency: string): Promise<TaxRate | null> {
    const row = await this.repo.getDefaultRate(currency);
    return row ? toTaxRate(row) : null;
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
    // Pre-flight uniqueness check on `code`. The DB constraint catches
    // the race; the application check catches the common-case "operator
    // re-submitted" so we surface a clean ConflictError without relying
    // on the SQLSTATE classifier.
    const existing = await this.repo.getRateByCode(input.code);
    if (existing) {
      throw new ConflictError("Tax rate code already exists.", {
        code: input.code,
      });
    }

    const rateId = id("tax");
    if (input.isDefault) {
      // Clear-then-set inside one transaction so the partial unique index
      // never sees two defaults for the same currency.
      const row = await this.repo.withTransaction(async (tx) => {
        await tx.clearDefaultsForCurrency(input.currency);
        return tx.insertRate({
          id: rateId,
          code: input.code,
          name: input.name,
          rateBasisPoints: input.rateBasisPoints,
          currency: input.currency,
          isDefault: true,
        });
      });
      return toTaxRate(row);
    }

    const row = await this.repo.insertRate({
      id: rateId,
      code: input.code,
      name: input.name,
      rateBasisPoints: input.rateBasisPoints,
      currency: input.currency,
      isDefault: false,
    });
    return toTaxRate(row);
  }

  async updateRate(
    rateId: string,
    patch: UpdateTaxRateInput,
  ): Promise<TaxRate> {
    const existing = await this.repo.getRateById(rateId);
    if (!existing) {
      throw new NotFoundError("Tax rate not found.", { id: rateId });
    }
    if (existing.archivedAt !== null) {
      throw new ConflictError("Cannot update an archived tax rate.", {
        id: rateId,
      });
    }

    const fields: Partial<{
      name: string;
      rateBasisPoints: number;
      isDefault: boolean;
    }> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.rateBasisPoints !== undefined)
      fields.rateBasisPoints = patch.rateBasisPoints;

    // is_default flip (true) requires the same atomic clear-then-set as
    // create. is_default flip (false) is a simple update; no other rows
    // need to change.
    if (patch.isDefault === true) {
      const row = await this.repo.withTransaction(async (tx) => {
        await tx.clearDefaultsForCurrency(existing.currency);
        const updated = await tx.updateRate(rateId, {
          ...fields,
          isDefault: true,
        });
        if (!updated) {
          throw new NotFoundError("Tax rate not found.", { id: rateId });
        }
        return updated;
      });
      return toTaxRate(row);
    }

    const updated = await this.repo.updateRate(rateId, {
      ...fields,
      ...(patch.isDefault === false ? { isDefault: false } : {}),
    });
    if (!updated) {
      throw new NotFoundError("Tax rate not found.", { id: rateId });
    }
    return toTaxRate(updated);
  }

  async archiveRate(rateId: string): Promise<TaxRate> {
    const existing = await this.repo.getRateById(rateId);
    if (!existing) {
      throw new NotFoundError("Tax rate not found.", { id: rateId });
    }
    if (existing.archivedAt !== null) {
      // Idempotent: archiving an already-archived rate is a no-op.
      return toTaxRate(existing);
    }
    // Archiving also clears `is_default` so the partial unique index
    // remains satisfied without manual cleanup.
    const updated = await this.repo.updateRate(rateId, {
      archivedAt: new Date(),
      isDefault: false,
    });
    if (!updated) {
      throw new NotFoundError("Tax rate not found.", { id: rateId });
    }
    return toTaxRate(updated);
  }

  // -------------------------------------------------------------------
  // Pure compute
  // -------------------------------------------------------------------

  applyTax(amount: Money, rate: TaxRate): Money {
    // basis_points / 10000 — the conversion is integer-exact because we
    // store the rate as basis points. multiply()'s number factor goes
    // through toRatio() which decomposes 0.0011 into num/den bigints, so
    // the result is rounded only once at the end.
    const factor = rate.rateBasisPoints / 10_000;
    return moneyMultiply(amount, factor, { rounding: "halfEven" });
  }
}

/**
 * Default singleton wired to the runtime database. Tests construct
 * `TaxServiceImpl` directly with a fake repository.
 */
export const taxService: TaxService = new TaxServiceImpl(
  createTaxRateRepository(),
);
