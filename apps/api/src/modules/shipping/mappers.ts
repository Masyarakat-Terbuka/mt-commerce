/**
 * Drizzle row → shipping domain type mappers.
 *
 * The two-column `(flat_rate_amount, flat_rate_currency)` pair collapses
 * into a single `Money | null` so the rest of the system never sees the
 * raw bigint+currency tuple. The mapper returns `null` when either side
 * of the pair is missing — which the DB CHECK guarantees only happens
 * for plugin methods.
 *
 * Inverse mappers (domain → insert) live at the call sites because they
 * are simple field renames; only the read direction is non-trivial.
 */
import type { Money } from "@mt-commerce/core/money";
import type {
  FulfillmentRow,
  ShippingMethodRow,
} from "../../db/schema/index.js";
import type {
  Fulfillment,
  FulfillmentStatus,
  ShippingMethod,
  ShippingProviderKind,
} from "./types.js";

export function toShippingMethod(row: ShippingMethodRow): ShippingMethod {
  let flatRate: Money | null = null;
  if (row.flatRateAmount !== null && row.flatRateCurrency !== null) {
    flatRate = {
      amount: row.flatRateAmount,
      currency: row.flatRateCurrency,
    };
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    // The DB column is plain text; the domain narrows to the union.
    providerKind: row.providerKind as ShippingProviderKind,
    flatRate,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function toFulfillment(row: FulfillmentRow): Fulfillment {
  return {
    id: row.id,
    orderIntentId: row.orderIntentId,
    shippingMethodId: row.shippingMethodId,
    status: row.status as FulfillmentStatus,
    trackingCode: row.trackingCode ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
