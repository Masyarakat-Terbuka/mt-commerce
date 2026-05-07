/**
 * Auth module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules import only what this file
 * re-exports. The catalog admin routes, the customer module, and any future
 * staff-gated route reach for `requireRole`/`requireAuth` from here, never
 * from the implementation files.
 *
 * Public surface:
 *   - Domain types: `AuthUser`, `AuthSession`, `StaffProfile`, `Role`,
 *     `Scope`, `ApiKey`, `AuthMode`, `AuthAppBindings`.
 *   - The `AuthService` interface and the singleton `authService`.
 *   - Middleware factories: `requireAuth`, `requireRole(...roles)`,
 *     `requireScope(scope)`. The factories are pre-bound to the singleton
 *     so callers do not pass the service around.
 *   - Route builders: `adminRoutes`, `storefrontRoutes`.
 *   - The Better Auth instance accessor `getAuth()` for the app.ts handler
 *     mount.
 */
import {
  buildRequireAuth,
  buildRequireRole,
  buildRequireScope,
} from "./middleware.js";
import { authService } from "./service.js";
import { buildAuthAdminRoutes } from "./routes/admin.js";
import { buildAuthStorefrontRoutes } from "./routes/storefront.js";

export type {
  AuthMode,
  AuthSession,
  AuthUser,
  ApiKey,
  Role,
  Scope,
  StaffProfile,
  RegisterInput,
  LoginInput,
  ChangePasswordInput,
  AssignRoleInput,
  CreateApiKeyInput,
} from "./types.js";

export { ROLES, SCOPES, roleSchema, scopeSchema } from "./types.js";

export type { AuthService } from "./service.js";
export { AuthServiceImpl, authService } from "./service.js";

export type { AuthAppBindings, AuthVariables } from "./middleware.js";
export { getAuthedUser } from "./middleware.js";

export { getAuth } from "./better-auth.js";

/**
 * Pre-bound middlewares wired to the runtime `authService`. Routes that need
 * to override the service (e.g. tests) can construct their own via
 * `buildRequireAuth(service)`.
 */
export const requireAuth = buildRequireAuth(authService);
export const requireRole = buildRequireRole(authService);
export const requireScope = buildRequireScope();

export const adminRoutes = buildAuthAdminRoutes(authService);
export const storefrontRoutes = buildAuthStorefrontRoutes(authService);
