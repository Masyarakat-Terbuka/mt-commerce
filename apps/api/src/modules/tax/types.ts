/**
 * Tax module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the cart and checkout modules:
 *
 *   1. Domain types (`TaxRate`) — clean shapes the rest of the system
 *      consumes. Dates are `Date` instances; the route layer converts to
 *      ISO strings on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for
 *      request shape; surfaced through the standard validation_error envelope.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES } from "@mt-commerce/core/money";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface TaxRate {
  id: string;
  /** Stable operator-facing code, e.g. "PPN_11". */
  code: string;
  name: string;
  /**
   * Rate stored as basis points: 1100 = 11.00%. The conversion to a
   * fraction (`basisPoints / 10000`) happens at apply-time in `applyTax`.
   * Keeping the integer form on the wire keeps the value exact across
   * serialization boundaries.
   */
  rateBasisPoints: number;
  currency: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const knownCurrencySet = new Set<string>(KNOWN_CURRENCIES);

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" })
  .refine((code) => knownCurrencySet.has(code), {
    message: `currency must be one of: ${[...KNOWN_CURRENCIES].sort().join(", ")}`,
  });

/**
 * Basis points bound: 0 to 10000 (0%..100%). A rate above 100% would be
 * a misconfiguration; the upper bound rejects it at the boundary rather
 * than letting the cart silently apply a >100% multiplier.
 */
const basisPointsSchema = z
  .number()
  .int({ message: "rateBasisPoints must be an integer" })
  .min(0, { message: "rateBasisPoints must be >= 0" })
  .max(10_000, { message: "rateBasisPoints must be <= 10000 (100%)" });

const codeSchema = z
  .string()
  .min(1, { message: "code must not be empty" })
  .max(64, { message: "code must be <= 64 characters" })
  .regex(/^[A-Z0-9_]+$/, {
    message: "code must contain only A-Z, 0-9, and underscores",
  });

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const createTaxRateSchema = z.object({
  code: codeSchema,
  name: z.string().min(1).max(255),
  rateBasisPoints: basisPointsSchema,
  currency: currencySchema,
  isDefault: z.boolean().optional().default(false),
});
export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;

export const updateTaxRateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    rateBasisPoints: basisPointsSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.rateBasisPoints !== undefined ||
      patch.isDefault !== undefined,
    { message: "patch must include at least one of: name, rateBasisPoints, isDefault" },
  );
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;

export const listTaxRatesQuerySchema = z.object({
  /** When set, returns only non-archived rates. Default true (admin-friendly). */
  activeOnly: z.coerce.boolean().optional().default(true),
});
export type ListTaxRatesQuery = z.infer<typeof listTaxRatesQuerySchema>;

export const getDefaultRateQuerySchema = z.object({
  currency: currencySchema,
});
