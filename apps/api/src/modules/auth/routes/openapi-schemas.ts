/**
 * Shared OpenAPI wire-shape schemas for the auth routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reuse the user-shape
 * schema; admin additionally has staff-profile, session, and API-key shapes.
 *
 * Note: Better Auth's `/api/auth/*` handler is NOT documented in this file
 * — it's mounted in `app.ts` as a plain Hono `app.all(...)` handler and is
 * deliberately excluded from the OpenAPI surface. Better Auth manages its
 * own routes and they are documented in its own README.
 */
import { z } from "@hono/zod-openapi";

export const AuthUserPublic = z
  .object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
  })
  .openapi("AuthUser");

export const StaffProfileWire = z
  .object({
    authUserId: z.string(),
    role: z.enum(["owner", "admin", "staff", "viewer"]),
    displayName: z.string(),
  })
  .openapi("StaffProfile");

export const StaffProfileFull = z
  .object({
    authUserId: z.string(),
    role: z.enum(["owner", "admin", "staff", "viewer"]),
    displayName: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("StaffProfileFull");

export const MeAdminResponse = z
  .object({
    user: AuthUserPublic,
    staff: StaffProfileWire.nullable(),
  })
  .openapi("MeAdminResponse");

export const MeStorefrontResponse = z
  .object({
    user: AuthUserPublic.nullable(),
  })
  .openapi("MeStorefrontResponse");

export const SessionWire = z
  .object({
    id: z.string(),
    expiresAt: z.string(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Session");

export const SessionListEnvelope = z
  .object({ data: z.array(SessionWire) })
  .openapi("SessionList");

export const ApiKeyWire = z
  .object({
    id: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi("ApiKey");

export const ApiKeyListEnvelope = z
  .object({ data: z.array(ApiKeyWire) })
  .openapi("ApiKeyList");

export const ApiKeyCreated = z
  .object({
    id: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    plaintext: z.string().openapi({
      description:
        "The freshly issued API key. Returned ONCE here. The database does not retain it.",
    }),
    createdAt: z.string(),
  })
  .openapi("ApiKeyCreated");
