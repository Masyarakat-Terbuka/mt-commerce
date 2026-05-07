/**
 * Wire-shape helpers — convert tax domain types to JSON-safe payloads.
 *
 * `Date` → ISO 8601 string. There is no `Money` value on a tax rate
 * (rates are integers in basis points), so the conversion is straightforward.
 */
import type { TaxRate } from "../types.js";

export interface WireTaxRate {
  id: string;
  code: string;
  name: string;
  rateBasisPoints: number;
  currency: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toWireTaxRate(rate: TaxRate): WireTaxRate {
  return {
    id: rate.id,
    code: rate.code,
    name: rate.name,
    rateBasisPoints: rate.rateBasisPoints,
    currency: rate.currency,
    isDefault: rate.isDefault,
    createdAt: rate.createdAt.toISOString(),
    updatedAt: rate.updatedAt.toISOString(),
    archivedAt: rate.archivedAt ? rate.archivedAt.toISOString() : null,
  };
}
