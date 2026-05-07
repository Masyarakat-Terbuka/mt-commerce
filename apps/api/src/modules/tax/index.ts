/**
 * Tax module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing layer
 * import only what this file re-exports. Anything not surfaced here is an
 * implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain type: `TaxRate`.
 *   - The `TaxService` interface and a default `taxService` singleton wired
 *     to the runtime database.
 *   - Route builders (`buildTaxAdminRoutes`, `buildTaxStorefrontRoutes`)
 *     plus pre-built singletons (`adminRoutes`, `storefrontRoutes`).
 */
import { buildTaxAdminRoutes } from "./routes/admin.js";
import { buildTaxStorefrontRoutes } from "./routes/storefront.js";
import { taxService } from "./service.js";

export type {
  CreateTaxRateInput,
  ListTaxRatesQuery,
  TaxRate,
  UpdateTaxRateInput,
} from "./types.js";

export type { TaxService } from "./service.js";
export { TaxServiceImpl } from "./service.js";

export { taxService };
export { buildTaxAdminRoutes, buildTaxStorefrontRoutes };

export const adminRoutes = buildTaxAdminRoutes(taxService);
export const storefrontRoutes = buildTaxStorefrontRoutes(taxService);
