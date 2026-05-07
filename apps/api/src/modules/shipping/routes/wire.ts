/**
 * Wire-shape helpers — convert shipping domain types to JSON-safe payloads.
 *
 *   - `Date` → ISO 8601 string
 *   - `Money` → `MoneyJSON` (string `amount`) per ADR-0007
 *   - Optional fields render as `null`, never absent
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Fulfillment,
  FulfillmentStatus,
  ShippingMethod,
  ShippingProviderKind,
} from "../types.js";

export interface WireShippingMethod {
  id: string;
  code: string;
  name: string;
  providerKind: ShippingProviderKind;
  flatRate: MoneyJSON | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireFulfillment {
  id: string;
  orderIntentId: string;
  shippingMethodId: string;
  status: FulfillmentStatus;
  trackingCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toWireShippingMethod(
  method: ShippingMethod,
): WireShippingMethod {
  return {
    id: method.id,
    code: method.code,
    name: method.name,
    providerKind: method.providerKind,
    flatRate: method.flatRate ? moneyToJSON(method.flatRate) : null,
    isActive: method.isActive,
    createdAt: method.createdAt.toISOString(),
    updatedAt: method.updatedAt.toISOString(),
    deletedAt: method.deletedAt ? method.deletedAt.toISOString() : null,
  };
}

export function toWireFulfillment(fulfillment: Fulfillment): WireFulfillment {
  return {
    id: fulfillment.id,
    orderIntentId: fulfillment.orderIntentId,
    shippingMethodId: fulfillment.shippingMethodId,
    status: fulfillment.status,
    trackingCode: fulfillment.trackingCode,
    createdAt: fulfillment.createdAt.toISOString(),
    updatedAt: fulfillment.updatedAt.toISOString(),
  };
}
