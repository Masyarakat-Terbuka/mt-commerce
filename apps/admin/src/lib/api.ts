/**
 * The single boundary between the admin app and the API.
 *
 * Admin views authenticate via the Better Auth session cookie. The SDK's
 * admin namespace flips `credentials: "include"` for every request, so the
 * cookie travels even when the admin app is served from a different origin
 * than the API in development.
 *
 * Errors funnel through the SDK's `ApiError`. We re-export it here so screen
 * components can branch on `error.code` without importing from the SDK
 * directly — that path is also fine, but a single import surface keeps the
 * call sites tidy.
 */
import { createClient } from "@mt-commerce/sdk";
export { ApiError } from "@mt-commerce/sdk";
export type {
  AdjustInventoryInput,
  AdminCreateCustomerInput,
  AdminListCustomersQuery,
  AdminListInventoryAuditQuery,
  AdminListInventoryQuery,
  AdminListOrdersQuery,
  AdminListProductsQuery,
  AdminUpdateCustomerInput,
  AuthMe,
  CancelFulfillmentInput,
  CancelOrderAdminInput,
  Category,
  Customer,
  CustomerAddress,
  CustomerWithAddresses,
  Fulfillment,
  FulfillmentStatus,
  InventoryAuditEntry,
  InventoryLevel,
  MarkFulfillmentShippedInput,
  Order,
  OrderActorKind,
  OrderAddressSnapshot,
  OrderItem,
  OrderStatus,
  OrderStatusEvent,
  Paginated,
  SetFulfillmentTrackingInput,
  Product,
  ProductSort,
  ProductStatus,
  Role,
  StoreSettings,
  TaxRate,
  TransitionOrderInput,
  UpdateStoreSettingsInput,
  Variant,
} from "@mt-commerce/sdk";

const DEFAULT_API_URL = "http://localhost:8000";

function resolveApiUrl(): string {
  // Vite inlines `VITE_*` env vars at build time. We fall back to the dev
  // API port so a fresh clone with no .env still boots usefully.
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  return raw && raw.length > 0 ? raw : DEFAULT_API_URL;
}

export const api = createClient({ baseUrl: resolveApiUrl() });
