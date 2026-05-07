/**
 * Customer module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `Customer`, `CustomerAddress`, `Province`, `City`,
 *     `District`, `Subdistrict`, `Paginated<T>`, plus the input shapes.
 *   - The `CustomerService` interface and a default `customerService`
 *     singleton wired to the runtime database.
 *   - HTTP route builders (`buildCustomerAdminRoutes`,
 *     `buildCustomerStorefrontRoutes`) and pre-built singletons
 *     (`adminRoutes`, `storefrontRoutes`) — the same pattern catalog uses.
 */
import { buildCustomerAdminRoutes } from "./routes/admin.js";
import { buildCustomerStorefrontRoutes } from "./routes/storefront.js";
import { customerService } from "./service.js";

export type {
  AddressKind,
  City,
  CreateAddressInput,
  CreateCustomerInput,
  Customer,
  CustomerAddress,
  District,
  ListCustomersQuery,
  ListKecamatanQuery,
  ListKelurahanQuery,
  ListKotaKabupatenQuery,
  Paginated,
  Province,
  SetDefaultAddressInput,
  Subdistrict,
  UpdateAddressInput,
  UpdateCustomerInput,
} from "./types.js";

export type { CustomerService } from "./service.js";
export { CustomerServiceImpl } from "./service.js";

export { customerService };
export { buildCustomerAdminRoutes, buildCustomerStorefrontRoutes };

export const adminRoutes = buildCustomerAdminRoutes(customerService);
export const storefrontRoutes = buildCustomerStorefrontRoutes(customerService);
