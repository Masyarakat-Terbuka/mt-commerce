/**
 * Settings module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing
 * layer import only what this file re-exports. Anything not surfaced here
 * is an implementation detail and is not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types: `StoreSettings`, `SupportedLocale`, plus the input
 *     shape `UpdateSettingsInput`.
 *   - The `SettingsService` interface and a default `settingsService`
 *     singleton wired to the runtime database.
 *   - HTTP route builder (`buildSettingsAdminRoutes`) and a pre-built
 *     singleton (`adminRoutes`) — same pattern catalog/customer use.
 *
 * No storefront router: settings is admin-only at v0.1. The storefront
 * does not need to read merchant-internal config.
 */
import { buildSettingsAdminRoutes } from "./routes/admin.js";
import { settingsService } from "./service.js";

export type {
  StoreSettings,
  SupportedLocale,
  UpdateSettingsInput,
} from "./types.js";

export type { SettingsService } from "./service.js";
export { SettingsServiceImpl } from "./service.js";

export { settingsService };
export { buildSettingsAdminRoutes };

export const adminRoutes = buildSettingsAdminRoutes(settingsService);
