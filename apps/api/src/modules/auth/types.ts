/**
 * Auth domain types and Zod schemas.
 *
 * Two layers:
 *   1. Domain types — the clean shapes the rest of the system consumes
 *      (`AuthUser`, `AuthSession`, `StaffProfile`, `Role`, `Scope`, `ApiKey`).
 *      These never leak Drizzle row types or Better Auth internals.
 *   2. Zod schemas — the source of truth for HTTP request validation. They
 *      surface errors through the standard `validation_error` envelope the
 *      catalog routes already use.
 *
 * The role set is fixed (`owner`, `admin`, `staff`, `viewer`) per the
 * "Authentication and authorization" section of ARCHITECTURE.md. Adding a
 * role is an additive enum migration plus an entry here.
 */
import { z } from "zod";

// ----------------------------------------------------------------------------
// Roles and scopes
// ----------------------------------------------------------------------------

export const ROLES = ["owner", "admin", "staff", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES);

/**
 * Starter scope set for API keys. Documented in the module README. Routes
 * that accept API-key auth assert one of these via `requireScope("...")`.
 *
 * The set is intentionally small for v0.1 — adding a scope is one entry here
 * plus a doc update. Wildcards (`catalog:*`) are deliberately not supported
 * to keep the membership check trivial and the audit story explicit.
 */
export const SCOPES = [
  "catalog:read",
  "catalog:write",
  "webhooks:receive",
] as const;
export type Scope = (typeof SCOPES)[number];

export const scopeSchema = z.enum(SCOPES);

// ----------------------------------------------------------------------------
// Domain types
// ----------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface StaffProfile {
  authUserId: string;
  role: Role;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  scopes: Scope[];
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * The two ways a request can be authenticated. Routes inspect `c.var.authMode`
 * if they need to decide between them — most just call `requireAuth()` and
 * accept either.
 */
export type AuthMode = "session" | "api_key";

// ----------------------------------------------------------------------------
// Request schemas
// ----------------------------------------------------------------------------

const emailSchema = z
  .string()
  .min(3)
  .max(254)
  .email({ message: "must be a valid email address" });

/**
 * Password rule: at least 12 chars, with at least one letter and one digit.
 * 12 is the SECURITY.md commitment; the regex is a soft floor that catches
 * obvious weak choices without locking out password managers.
 */
const passwordSchema = z
  .string()
  .min(12, { message: "password must be at least 12 characters" })
  .max(128, { message: "password must be at most 128 characters" })
  .regex(/[A-Za-z]/, { message: "password must contain at least one letter" })
  .regex(/\d/, { message: "password must contain at least one digit" });

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const assignRoleSchema = z.object({
  authUserId: z.string().min(1),
  role: roleSchema,
  displayName: z.string().min(1).max(200),
});
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z
    .array(scopeSchema)
    .min(1, { message: "at least one scope is required" })
    .max(SCOPES.length),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
