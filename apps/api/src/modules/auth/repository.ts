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

/**
 * Repository surface — declared as an explicit interface (rather than
 * `ReturnType<typeof createAuthRepository>`) because `withTransaction`
 * recursively references the same type, which would otherwise produce a
 * "circularly references itself" TS error. The interface also makes the
 * test fakes' coverage obligation explicit.
 */
export interface AuthRepository {
  getUserById(id: string): Promise<AuthUserRow | null>;
  getUserByEmail(email: string): Promise<AuthUserRow | null>;
  listSessionsForUser(userId: string): Promise<AuthSessionRow[]>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  getStaffProfile(authUserId: string): Promise<StaffProfileRow | null>;
  upsertStaffProfile(input: NewStaffProfileRow): Promise<StaffProfileRow>;
  /**
   * List every staff_profile row joined with the matching auth_user email.
   * The join is left-anchored on the staff row so a profile whose underlying
   * auth user has been hard-deleted still surfaces (with a null email) —
   * the operator can then promote a replacement and clean up.
   */
  listStaff(): Promise<Array<StaffProfileRow & { email: string | null }>>;
  hasAnyStaff(): Promise<boolean>;
  /** Take an advisory lock on the staff_profiles namespace for the
   *  current transaction. See implementation comment for details. */
  lockStaffNamespace(): Promise<void>;
  countStaffByRole(role: Role): Promise<number>;
  withTransaction<T>(fn: (tx: AuthRepository) => Promise<T>): Promise<T>;
  insertApiKey(row: NewApiKeyRow): Promise<ApiKeyRow>;
  getApiKeyById(id: string): Promise<ApiKeyRow | null>;
  getActiveApiKeyById(id: string): Promise<ApiKeyRow | null>;
  listApiKeysForUser(userId: string): Promise<ApiKeyRow[]>;
  /** Returns true iff the row was still active and got touched. */
  touchApiKey(id: string): Promise<boolean>;
  revokeApiKey(id: string): Promise<void>;
}

export function createAuthRepository(db: Db = defaultDb): AuthRepository {
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

    async listStaff(): Promise<Array<StaffProfileRow & { email: string | null }>> {
    // Join staff_profiles with auth_users so the admin UI can render the
    // operator's email next to their role and display name. The join uses
    // a left join so a staff row pointing at a deleted auth user still
    // surfaces (with a null email) — that is recoverable through the
    // existing assignRole flow rather than a silent disappearance.
    const rows = await db
      .select({
        authUserId: staffProfiles.authUserId,
        role: staffProfiles.role,
        displayName: staffProfiles.displayName,
        createdAt: staffProfiles.createdAt,
        updatedAt: staffProfiles.updatedAt,
        email: authUsers.email,
      })
      .from(staffProfiles)
      .leftJoin(authUsers, eq(authUsers.id, staffProfiles.authUserId))
      .orderBy(desc(staffProfiles.createdAt));
    return rows.map((r) => ({
      authUserId: r.authUserId,
      role: r.role,
      displayName: r.displayName,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      email: r.email ?? null,
    }));
  },

  async hasAnyStaff(): Promise<boolean> {
      const [row] = await db
        .select({ exists: sql<number>`1` })
        .from(staffProfiles)
        .limit(1);
      return Boolean(row);
    },

    /**
     * Lock the staff_profiles "namespace" for the duration of the
     * surrounding transaction. Used by the assignRole flow to serialize
     * the first-staff-must-be-owner check + write so that two concurrent
     * `assignRole` calls cannot both observe `hasAnyStaff() === false`
     * and both succeed with non-owner roles, leaving the platform with no
     * owner.
     *
     * Implementation: `pg_advisory_xact_lock` keyed on a fixed integer.
     * Advisory locks live for the transaction's lifetime and are
     * released on commit/rollback automatically, with no row-level
     * collateral damage. The constant `483921` is just a fingerprint;
     * any module reusing it would also serialize against this flow,
     * which is the desired behavior for the (rare) cross-flow
     * "is there an owner?" question.
     */
    async lockStaffNamespace(): Promise<void> {
      await db.execute(sql`SELECT pg_advisory_xact_lock(483921)`);
    },

    async countStaffByRole(role: Role): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(staffProfiles)
        .where(eq(staffProfiles.role, role));
      return row?.count ?? 0;
    },

    /**
     * Run `fn` inside a single Postgres transaction. The callback receives
     * a fresh `AuthRepository` bound to the transactional client so every
     * call inside it sees the in-flight changes (and is rolled back as a
     * unit on throw).
     *
     * Used by AuthService.assignRole to make the (lock + check + write)
     * sequence atomic for the first-owner and last-owner invariants.
     */
    async withTransaction<T>(
      fn: (tx: AuthRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createAuthRepository(tx as unknown as Db)),
      );
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

    /**
     * Update `last_used_at` only if the row is still active. Returns
     * `true` when the row was touched, `false` when it has been revoked
     * since the verify-time fetch (i.e. an in-flight request that lost
     * the race against a concurrent revoke). The caller treats `false`
     * as "key revoked between fetch and touch" and rejects the request.
     *
     * Trade-off: this leaves a one-request window where a revoke is
     * reflected on the *next* request, not the in-flight one. The
     * alternative (every `verifyApiKey` doing a fresh round-trip with
     * `FOR UPDATE`) is too costly given the per-request Argon2id verify
     * already on the path. The audit trail stays clean because we never
     * stamp `last_used_at` on a revoked row.
     */
    async touchApiKey(id: string): Promise<boolean> {
      const rows = await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    },

    async revokeApiKey(id: string): Promise<void> {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    },
  };
}
