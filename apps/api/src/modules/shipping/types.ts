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
/**
 * Fulfillment v0.1 lifecycle:
 *
 *   pending ──► shipped ──► delivered
 *           ↘           ↘
 *             cancelled    cancelled
 *
 * `delivered` and `cancelled` are terminal. The state machine lives in
 * `state.ts` so the service cannot diverge from the documented diagram.
 */
export type FulfillmentStatus =
  | "pending"
  | "shipped"
  | "delivered"
  | "cancelled";

export type FulfillmentActorKind = "system" | "staff" | "customer";

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
  orderId: string;
  shippingMethodId: string;
  status: FulfillmentStatus;
  trackingCode: string | null;
  /** Set when status transitions to `shipped`. */
  trackedAt: Date | null;
  /** Set when status transitions to `delivered`. */
  deliveredAt: Date | null;
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

/**
 * Optional buyer destination forwarded onto the provider's `quote` call.
 * Plugin providers (Biteship, JNE direct) that need a real shipment to
 * price consume these fields; the manual provider ignores them.
 *
 * The region ids are the same BPS-coded shape stored on the platform's
 * `addresses` rows. The HTTP boundary parses them through the wire
 * schemas; the service-internal type below is structural so internal
 * callers (cart, checkout) can forward whatever they have without an
 * extra Zod parse.
 */
export interface QuoteShippingDestination {
  provinsiId?: string | null;
  kotaKabupatenId?: string | null;
  kecamatanId?: string | null;
  kelurahanId?: string | null;
  postalCode?: string | null;
}

/**
 * Cart-item subset forwarded onto the provider's `quote` call. Mirrors
 * what couriers actually need (identity, quantity, weight, dimensions).
 * All fields beyond `quantity` are optional — providers that need richer
 * data must throw a clear domain error when missing.
 */
export interface QuoteShippingItem {
  productId?: string;
  variantId?: string;
  quantity: number;
  weight?: number;
  value?: bigint;
  length?: number;
  width?: number;
  height?: number;
  name?: string;
}

export const quoteShippingSchema = z.object({
  methodCode: codeSchema,
  currency: currencySchema,
});
export type QuoteShippingHttpInput = z.infer<typeof quoteShippingSchema>;

/**
 * Service-layer input. Adds the optional `destination` and `items`
 * forwarded to the underlying provider. The HTTP boundary today only
 * accepts `methodCode + currency` (storefront preview); the cart and
 * checkout call sites build the richer shape from the cart they already
 * hold, so the service signature accepts both.
 */
export type QuoteShippingInput = QuoteShippingHttpInput & {
  destination?: QuoteShippingDestination;
  items?: readonly QuoteShippingItem[];
};

// ---------------------------------------------------------------------------
// Fulfillment input schemas
// ---------------------------------------------------------------------------

/**
 * Tracking code: free-text courier reference. Length-bounded so a stray
 * paste of an entire email cannot land in the column. Trimmed at the
 * service boundary; a whitespace-only value folds to null.
 */
const trackingCodeSchema = z
  .string()
  .min(1, { message: "trackingCode must not be empty" })
  .max(120, { message: "trackingCode must be <= 120 characters" });

export const setFulfillmentTrackingSchema = z.object({
  /** Pass null to clear an existing code. */
  trackingCode: trackingCodeSchema.nullable(),
});
export type SetFulfillmentTrackingInput = z.infer<
  typeof setFulfillmentTrackingSchema
>;

/**
 * `mark-shipped` accepts an optional tracking code so the operator can
 * supply it in the same request rather than splitting the action into
 * two calls — this matches how courier hand-off actually works.
 */
export const markFulfillmentShippedSchema = z.object({
  trackingCode: trackingCodeSchema.optional(),
});
export type MarkFulfillmentShippedInput = z.infer<
  typeof markFulfillmentShippedSchema
>;

/** `mark-delivered` carries no body in v0.1; a sibling schema is kept for shape parity. */
export const markFulfillmentDeliveredSchema = z.object({}).strict();
export type MarkFulfillmentDeliveredInput = z.infer<
  typeof markFulfillmentDeliveredSchema
>;

export const cancelFulfillmentSchema = z.object({
  /** Free-text reason; trimmed and folded to null when only whitespace. */
  reason: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return null;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
});
export type CancelFulfillmentInput = z.infer<typeof cancelFulfillmentSchema>;

export const listFulfillmentsQuerySchema = z.object({
  /**
   * Currently the only supported filter. The route requires it (one
   * fulfillment per order in v0.1; "list everything" is not a meaningful
   * call yet) — Zod treats it as required and the route surfaces 400.
   */
  orderId: z.string().min(1).max(100),
});
export type ListFulfillmentsQuery = z.infer<typeof listFulfillmentsQuerySchema>;
