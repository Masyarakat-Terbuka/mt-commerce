/**
 * Shared Hono context variables used across middleware and routes.
 *
 * Set typed values via `c.set("requestId", ...)` and read them with
 * `c.get("requestId")`. The `Variables` type is wired into the app factory.
 *
 * Auth-related variables (`authUser`, `authSession`, `apiKey`,
 * `staffProfile`, `authMode`) are declared here as optional so middleware
 * downstream of `requireAuth()` can read them through `c.var.authUser`
 * without each module redeclaring the binding type. The actual narrowing
 * (always present after `requireAuth({ required: true })`) is enforced by
 * the middleware contract — see `apps/api/src/modules/auth/middleware.ts`.
 */
import type { Logger } from "pino";

/**
 * Forward-only types from the auth module — re-declared here to avoid a
 * circular import (auth depends on this file for `AppVariables`). The
 * shapes match the canonical definitions in `modules/auth/types.ts` and
 * `modules/auth/middleware.ts`.
 */
export type AuthMode = "session" | "api_key";

export interface AppAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppAuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface AppApiKey {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AppStaffProfile {
  authUserId: string;
  role: "owner" | "admin" | "staff" | "viewer";
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppVariables {
  requestId: string;
  logger: Logger;
  authUser?: AppAuthUser;
  authMode?: AuthMode;
  authSession?: AppAuthSession;
  apiKey?: AppApiKey;
  staffProfile?: AppStaffProfile;
}

export interface AppBindings {
  Variables: AppVariables;
}
