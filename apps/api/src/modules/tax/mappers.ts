/**
 * Drizzle row → tax domain type mapper.
 *
 * The mapping is total — every column has a 1:1 destination in the domain
 * object. The inverse direction is handled inline at insert/update sites
 * because it is a simple field rename.
 */
import type { TaxRateRow } from "../../db/schema/index.js";
import type { TaxRate } from "./types.js";

export function toTaxRate(row: TaxRateRow): TaxRate {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    rateBasisPoints: row.rateBasisPoints,
    currency: row.currency,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}
