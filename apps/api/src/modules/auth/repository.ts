/**
 * Auth repository — Drizzle queries against the auth, staff_profiles, and
 * api_keys tables.
 *
 * Per ADR-0005, the auth module owns these tables; cross-module callers must
 * not import this file. They go through `AuthService` (see `service.ts`).
 *
 * Better Auth owns the bulk of the user/session/account/verification reads
 * and writes itself through its Drizzle adapter — those rows still live in
 * our schema (so Track B's `customers.auth_user_id` FK can target them), but
 * we do not duplicate Better Auth's logic here. This repository covers the
 * thin slice the AuthService needs directly: looking up a user, listing/
 * revoking sessions, managing staff profiles, and CRUD on API keys.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  apiKeys,
  authSessions,
  authUsers,
  staffProfiles,
  type ApiKeyRow,
  type AuthSessionRow,
  type AuthUserRow,
  type NewApiKeyRow,
  type NewStaffProfileRow,
  type StaffProfileRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { Role } from "./types.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export function createAuthRepository(db: Db = defaultDb) {
  return {
    // ---------------------------------------------------------------
    // Users (read-only — Better Auth owns writes)
    // ---------------------------------------------------------------
    async getUserById(id: string): Promise<AuthUserRow | null> {
      const [row] = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, id))
        .limit(1);
      return row ?? null;
    },

    async getUserByEmail(email: string): Promise<AuthUserRow | null> {
      const [row] = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, email))
        .limit(1);
      return row ?? null;
    },

    // ---------------------------------------------------------------
    // Sessions
    // ---------------------------------------------------------------
    async listSessionsForUser(userId: string): Promise<AuthSessionRow[]> {
      return db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, userId))
        .orderBy(desc(authSessions.createdAt));
    },

    async deleteSession(id: string): Promise<void> {
      await db.delete(authSessions).where(eq(authSessions.id, id));
    },

    async deleteSessionsForUser(userId: string): Promise<void> {
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
    },

    // ---------------------------------------------------------------
    // Staff profiles
    // ---------------------------------------------------------------
    async getStaffProfile(authUserId: string): Promise<StaffProfileRow | null> {
      const [row] = await db
        .select()
        .from(staffProfiles)
        .where(eq(staffProfiles.authUserId, authUserId))
        .limit(1);
      return row ?? null;
    },

    async upsertStaffProfile(
      input: NewStaffProfileRow,
    ): Promise<StaffProfileRow> {
      // ON CONFLICT on the PK so the same call can both create and update.
      const [row] = await db
        .insert(staffProfiles)
        .values(input)
        .onConflictDoUpdate({
          target: staffProfiles.authUserId,
          set: {
            role: input.role,
            displayName: input.displayName,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("upsertStaffProfile: returning() yielded no rows");
      return row;
    },

    async hasAnyStaff(): Promise<boolean> {
      const [row] = await db
        .select({ exists: sql<number>`1` })
        .from(staffProfiles)
        .limit(1);
      return Boolean(row);
    },

    async countStaffByRole(role: Role): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(staffProfiles)
        .where(eq(staffProfiles.role, role));
      return row?.count ?? 0;
    },

    // ---------------------------------------------------------------
    // API keys
    // ---------------------------------------------------------------
    async insertApiKey(row: NewApiKeyRow): Promise<ApiKeyRow> {
      const [inserted] = await db.insert(apiKeys).values(row).returning();
      if (!inserted) throw new Error("insertApiKey: returning() yielded no rows");
      return inserted;
    },

    async getApiKeyById(id: string): Promise<ApiKeyRow | null> {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1);
      return row ?? null;
    },

    /**
     * Active = not revoked. The PK lookup is fine here even without the
     * partial index — we re-check `revoked_at` in code so a concurrent
     * revoke between read and use is also caught.
     */
    async getActiveApiKeyById(id: string): Promise<ApiKeyRow | null> {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .limit(1);
      return row ?? null;
    },

    async listApiKeysForUser(userId: string): Promise<ApiKeyRow[]> {
      return db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId))
        .orderBy(desc(apiKeys.createdAt));
    },

    async touchApiKey(id: string): Promise<void> {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, id));
    },

    async revokeApiKey(id: string): Promise<void> {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
