/**
 * Tax-rate seed.
 *
 * v0.1 ships with a single default Indonesian PPN rate at 11% (1100 basis
 * points). The seed is idempotent: a re-run does not duplicate the row.
 *
 * Idempotency strategy:
 *   - Rates are keyed on `code` (UNIQUE column). We `ON CONFLICT (code) DO
 *     NOTHING` so a re-seed on a populated DB is a no-op for the row.
 *   - The `is_default` flip is owned by the `tax_rates_default_per_-
 *     currency_unique_idx` partial unique index — even if a developer
 *     pre-created a default for IDR via the admin UI, the seed will
 *     either succeed (the developer had no row) or skip (the developer
 *     already has a PPN_11 row).
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { id } from "@mt-commerce/core/ulid";
import { taxRates } from "../../../db/schema/index.js";
import type * as schema from "../../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface TaxSeedSummary {
  ratesPresent: number;
  ratesInserted: number;
}

export async function seedDefaultTaxRates(db: Db): Promise<TaxSeedSummary> {
  const summary: TaxSeedSummary = { ratesPresent: 0, ratesInserted: 0 };

  // Check first; only insert if absent. The `ON CONFLICT (code) DO NOTHING`
  // path would also work, but the explicit check lets us count the
  // distinction between "already there" and "freshly inserted" for the
  // summary logging.
  const [existing] = await db
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(eq(taxRates.code, "PPN_11"))
    .limit(1);
  if (existing) {
    summary.ratesPresent = 1;
    return summary;
  }

  await db.insert(taxRates).values({
    id: id("tax"),
    code: "PPN_11",
    name: "Pajak Pertambahan Nilai 11%",
    rateBasisPoints: 1100,
    currency: "IDR",
    isDefault: true,
  });
  summary.ratesInserted = 1;
  return summary;
}
