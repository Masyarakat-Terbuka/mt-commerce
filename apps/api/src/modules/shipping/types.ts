/**
 * Shipping module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the cart and checkout modules:
 *
 *   1. Domain types (`ShippingMethod`, `Fulfillment`) — clean shapes the
 *      rest of the system consumes. Money is a `Money` value object;
 *      dates are `Date` instances; the route layer converts to ISO strings
 *      on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES, type Money } from "@mt-commerce/core/money";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ShippingProviderKind = "manual" | "plugin";
export type FulfillmentStatus = "pending" | "fulfilled" | "cancelled";

export interface ShippingMethod {
  id: string;
  /** Stable operator-facing code, e.g. "MANUAL_FLAT", "JNE_REG". */
  code: string;
  name: string;
  providerKind: ShippingProviderKind;
  /** Required when `providerKind === 'manual'`; null for plugin methods. */
  flatRate: Money | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Fulfillment {
  id: string;
  orderIntentId: string;
  shippingMethodId: string;
  status: FulfillmentStatus;
  trackingCode: string | null;
  createdAt: Date;
  updatedAt: Date;
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

const codeSchema = z
  .string()
  .min(1, { message: "code must not be empty" })
  .max(64, { message: "code must be <= 64 characters" })
  .regex(/^[A-Z0-9_]+$/, {
    message: "code must contain only A-Z, 0-9, and underscores",
  });

const providerKindSchema = z.enum(["manual", "plugin"]);

/**
 * Money input shape: `{ amount: "<integer-string>", currency: "<ISO>" }`.
 * Mirrors the wire shape (per ADR-0007). The string form preserves bigint
 * precision; the boundary parses to a `bigint`.
 */
const moneyInputSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+$/, {
      message: "amount must be a non-negative integer string",
    }),
  currency: currencySchema,
});

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Create shape:
 *   - manual ⇒ `flatRate` is required (and must be present in the body)
 *   - plugin ⇒ `flatRate` MUST be omitted (the plugin computes rates dynamically)
 *
 * The `superRefine` enforces the cross-field rule so the caller cannot
 * smuggle a flat rate into a plugin entry (which the DB CHECK would
 * reject anyway — failing fast at the boundary gives the operator a
 * cleaner error).
 */
export const createShippingMethodSchema = z
  .object({
    code: codeSchema,
    name: z.string().min(1).max(255),
    providerKind: providerKindSchema,
    flatRate: moneyInputSchema.optional(),
    /**
     * Optional in the input; the service treats `undefined` as `true`
     * (the storefront-friendly default). Kept optional in the inferred
     * type so test fakes and internal callers do not have to pass it
     * explicitly — the default lives at the service layer.
     */
    isActive: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.providerKind === "manual" && !value.flatRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flatRate"],
        message: "flatRate is required for manual shipping methods",
      });
    }
    if (value.providerKind === "plugin" && value.flatRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flatRate"],
        message:
          "flatRate must be omitted for plugin shipping methods; the plugin resolves rates dynamically",
      });
    }
  });
export type CreateShippingMethodInput = z.infer<
  typeof createShippingMethodSchema
>;

export const updateShippingMethodSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    flatRate: moneyInputSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.flatRate !== undefined ||
      patch.isActive !== undefined,
    { message: "patch must include at least one of: name, flatRate, isActive" },
  );
export type UpdateShippingMethodInput = z.infer<
  typeof updateShippingMethodSchema
>;

export const listShippingMethodsQuerySchema = z.object({
  /** Default true on the storefront; admin route overrides via `?activeOnly=false`. */
  activeOnly: z.coerce.boolean().optional().default(true),
});
export type ListShippingMethodsQuery = z.infer<
  typeof listShippingMethodsQuerySchema
>;

export const quoteShippingSchema = z.object({
  methodCode: codeSchema,
  currency: currencySchema,
});
export type QuoteShippingInput = z.infer<typeof quoteShippingSchema>;
