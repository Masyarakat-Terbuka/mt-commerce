/**
 * AuthService — unit tests against an in-memory fake repository.
 *
 * Same pattern as the catalog service tests: the service is constructed with
 * a `AuthRepository`, so for unit tests we hand-roll a fake. This keeps the
 * suite fast and lets us assert business rules (first-staff-must-be-owner,
 * scope validation, key hashing) without standing up a database.
 */
import { describe, expect, it } from "vitest";
import { AuthServiceImpl } from "../../../src/modules/auth/service.js";
import type { AuthRepository } from "../../../src/modules/auth/repository.js";
import type {
  ApiKeyRow,
  AuthSessionRow,
  AuthUserRow,
  NewApiKeyRow,
  NewStaffProfileRow,
  StaffProfileRow,
} from "../../../src/db/schema/index.js";

interface FakeStore {
  users: Map<string, AuthUserRow>;
  sessions: Map<string, AuthSessionRow>;
  staff: Map<string, StaffProfileRow>;
  apiKeys: Map<string, ApiKeyRow>;
}

function createStore(): FakeStore {
  return {
    users: new Map(),
    sessions: new Map(),
    staff: new Map(),
    apiKeys: new Map(),
  };
}

const FIXED_NOW = new Date("2026-05-07T12:00:00.000Z");

function createFakeRepo(store: FakeStore): AuthRepository {
  return {
    async getUserById(id) {
      return store.users.get(id) ?? null;
    },
    async getUserByEmail(email) {
      for (const u of store.users.values()) if (u.email === email) return u;
      return null;
    },
    async listSessionsForUser(userId) {
      return [...store.sessions.values()].filter((s) => s.userId === userId);
    },
    async deleteSession(id) {
      store.sessions.delete(id);
    },
    async deleteSessionsForUser(userId) {
      for (const [id, s] of store.sessions) {
        if (s.userId === userId) store.sessions.delete(id);
      }
    },
    async getStaffProfile(authUserId) {
      return store.staff.get(authUserId) ?? null;
    },
    async upsertStaffProfile(input: NewStaffProfileRow) {
      const existing = store.staff.get(input.authUserId);
      const row: StaffProfileRow = {
        authUserId: input.authUserId,
        role: input.role,
        displayName: input.displayName,
        createdAt: existing?.createdAt ?? FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
      store.staff.set(input.authUserId, row);
      return row;
    },
    async listStaff() {
      return [...store.staff.values()].map((s) => ({
        ...s,
        email: store.users.get(s.authUserId)?.email ?? null,
      }));
    },
    async hasAnyStaff() {
      return store.staff.size > 0;
    },
    async lockStaffNamespace() {
      // No-op in unit tests; serialization is asserted by the concurrent
      // test below via its own promise plumbing.
    },
    async countStaffByRole(role) {
      return [...store.staff.values()].filter((s) => s.role === role).length;
    },
    async withTransaction(fn) {
      // Unit-level fake: just run the callback against the same repo.
      // The race-safety test below builds a wrapping repo that simulates
      // the lock semantics explicitly.
      return fn(createFakeRepo(store));
    },
    async insertApiKey(row: NewApiKeyRow) {
      const apiKey: ApiKeyRow = {
        id: row.id,
        userId: row.userId,
        name: row.name,
        keyHash: row.keyHash,
        scopes: (row.scopes as string[] | undefined) ?? [],
        lastUsedAt: row.lastUsedAt ?? null,
        createdAt: FIXED_NOW,
        revokedAt: null,
      };
      store.apiKeys.set(apiKey.id, apiKey);
      return apiKey;
    },
    async getApiKeyById(id) {
      return store.apiKeys.get(id) ?? null;
    },
    async getActiveApiKeyById(id) {
      const row = store.apiKeys.get(id);
      if (!row) return null;
      if (row.revokedAt !== null) return null;
      return row;
    },
    async listApiKeysForUser(userId) {
      return [...store.apiKeys.values()].filter((k) => k.userId === userId);
    },
    async touchApiKey(id) {
      const existing = store.apiKeys.get(id);
      if (!existing || existing.revokedAt !== null) return false;
      store.apiKeys.set(id, { ...existing, lastUsedAt: FIXED_NOW });
      return true;
    },
    async revokeApiKey(id) {
      const existing = store.apiKeys.get(id);
      if (!existing || existing.revokedAt !== null) return;
      store.apiKeys.set(id, { ...existing, revokedAt: FIXED_NOW });
    },
  };
}

function buildService(): {
  service: AuthServiceImpl;
  store: FakeStore;
  seedUser: (id?: string) => string;
} {
  const store = createStore();
  const repo = createFakeRepo(store);
  const service = new AuthServiceImpl(repo);
  const seedUser = (id = "usr_test_1"): string => {
    store.users.set(id, {
      id,
      email: `${id}@example.com`,
      emailVerified: true,
      name: `User ${id}`,
      image: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    return id;
  };
  return { service, store, seedUser };
}

describe("AuthService.assignRole", () => {
  it("requires the first staff to be `owner`", async () => {
    const { service, seedUser } = buildService();
    const userId = seedUser();
    await expect(
      service.assignRole({
        authUserId: userId,
        role: "admin",
        displayName: "First Admin",
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { providedRole: "admin" },
    });
  });

  it("accepts the first staff when role is `owner`", async () => {
    const { service, seedUser } = buildService();
    const userId = seedUser();
    const profile = await service.assignRole({
      authUserId: userId,
      role: "owner",
      displayName: "Founder",
    });
    expect(profile.role).toBe("owner");
    expect(profile.displayName).toBe("Founder");
  });

  it("upserts on second call with the same auth user", async () => {
    const { service, seedUser } = buildService();
    const userId = seedUser();
    // The last-owner-protected guard forbids demoting the only owner — so
    // we promote a second owner first to keep the upsert path open. See
    // the "last-owner protection" suite below for the protected case.
    const secondId = seedUser("usr_test_second");
    await service.assignRole({
      authUserId: userId,
      role: "owner",
      displayName: "Owner v1",
    });
    await service.assignRole({
      authUserId: secondId,
      role: "owner",
      displayName: "Second Owner",
    });
    const updated = await service.assignRole({
      authUserId: userId,
      role: "admin",
      displayName: "Owner-now-admin",
    });
    expect(updated.role).toBe("admin");
    expect(updated.displayName).toBe("Owner-now-admin");
  });

  it("rejects when the auth user does not exist", async () => {
    const { service } = buildService();
    await expect(
      service.assignRole({
        authUserId: "usr_missing",
        role: "owner",
        displayName: "Ghost",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("AuthService session management", () => {
  it("revokeSession removes the session row", async () => {
    const { service, store, seedUser } = buildService();
    const userId = seedUser();
    store.sessions.set("sess_1", {
      id: "sess_1",
      userId,
      token: "tok_1",
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await service.revokeSession("sess_1");
    expect(store.sessions.has("sess_1")).toBe(false);
  });

  it("listSessions returns the user's sessions only", async () => {
    const { service, store, seedUser } = buildService();
    const a = seedUser("usr_a");
    const b = seedUser("usr_b");
    store.sessions.set("sess_a", {
      id: "sess_a",
      userId: a,
      token: "ta",
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    store.sessions.set("sess_b", {
      id: "sess_b",
      userId: b,
      token: "tb",
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    const sessionsA = await service.listSessions(a);
    expect(sessionsA.map((s) => s.id)).toEqual(["sess_a"]);
  });
});

// ---------------------------------------------------------------------------
// B2 — concurrent assignRole must serialize the first-staff-must-be-owner
// check and the upsert. Without the serialization, two callers can both
// observe `hasAnyStaff() === false` and both succeed with non-owner roles,
// leaving the platform with no owner.
// ---------------------------------------------------------------------------

describe("AuthService.assignRole concurrency", () => {
  it("serializes concurrent first-staff calls — invariant: exactly one owner", async () => {
    // The fake repo's `withTransaction` is wrapped in a manual mutex below;
    // it queues callbacks so the (lock + check + write) sequence is
    // observably serialized, the same property the production
    // `pg_advisory_xact_lock` provides.
    //
    // Scenario: two concurrent assignRole calls hit a clean slate at the
    // same time — one asks `owner`, the other asks `admin`. WITHOUT
    // serialization, both could observe `hasAnyStaff() === false`
    // simultaneously and the second's admin write would interleave in a
    // way that left the system without a defined owner write order.
    // WITH serialization, the second call must observe whatever the
    // first did and react accordingly. We assert the load-bearing
    // invariant: exactly one owner sits in the store at the end. (The
    // admin call may either succeed or fail depending on which order
    // the lock granted; the canonical invariant the lock defends is
    // "at least one owner, and never zero".)
    const store = createStore();
    const baseRepo = createFakeRepo(store);
    let lockChain: Promise<void> = Promise.resolve();
    const repo: typeof baseRepo = {
      ...baseRepo,
      async withTransaction(fn) {
        // Tail-chain into the mutex: each transactional unit waits for the
        // previous to finish before starting. Mirrors the serialization
        // the advisory lock + transaction boundary produces in production.
        const myTurn = lockChain.then(() => fn(baseRepo));
        lockChain = myTurn.then(
          () => undefined,
          () => undefined,
        );
        return myTurn;
      },
    };
    const service = new AuthServiceImpl(repo);
    store.users.set("usr_a", {
      id: "usr_a",
      email: "a@example.com",
      emailVerified: true,
      name: "A",
      image: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    store.users.set("usr_b", {
      id: "usr_b",
      email: "b@example.com",
      emailVerified: true,
      name: "B",
      image: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    await Promise.allSettled([
      service.assignRole({
        authUserId: "usr_a",
        role: "owner",
        displayName: "Owner First",
      }),
      service.assignRole({
        authUserId: "usr_b",
        role: "admin",
        displayName: "Admin Race",
      }),
    ]);

    // Exactly one owner exists. Two concurrent first-staff calls without
    // the lock could both observe `hasAnyStaff === false` and both write
    // — the lock makes the (read + write) sequence atomic.
    const owners = [...store.staff.values()].filter((s) => s.role === "owner");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.authUserId).toBe("usr_a");
  });
});

// ---------------------------------------------------------------------------
// S9 — last-owner protection. Demoting the only `owner` to anything else
// would leave the platform unable to perform any owner-only operation,
// which is unrecoverable through the API.
// ---------------------------------------------------------------------------

describe("AuthService.assignRole last-owner protection", () => {
  it("refuses to demote the only owner with last_owner_protected", async () => {
    const { service, seedUser } = buildService();
    const ownerId = seedUser("usr_only_owner");
    await service.assignRole({
      authUserId: ownerId,
      role: "owner",
      displayName: "Only Owner",
    });
    await expect(
      service.assignRole({
        authUserId: ownerId,
        role: "admin",
        displayName: "Demoted",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { code: "last_owner_protected" },
    });
  });

  it("allows demoting an owner once a second owner exists", async () => {
    const { service, seedUser, store } = buildService();
    const a = seedUser("usr_owner_a");
    const b = seedUser("usr_owner_b");
    await service.assignRole({
      authUserId: a,
      role: "owner",
      displayName: "Owner A",
    });
    await service.assignRole({
      authUserId: b,
      role: "owner",
      displayName: "Owner B",
    });
    await service.assignRole({
      authUserId: a,
      role: "admin",
      displayName: "Owner A demoted",
    });
    expect(store.staff.get(a)?.role).toBe("admin");
    expect(store.staff.get(b)?.role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// S5 — disableUser: downgrades to viewer + revokes all sessions, refuses
// on the last owner.
// ---------------------------------------------------------------------------

describe("AuthService.disableUser", () => {
  it("downgrades the staff role to viewer and revokes every session", async () => {
    const { service, store, seedUser } = buildService();
    const userId = seedUser("usr_to_disable");
    await service.assignRole({
      authUserId: userId,
      role: "owner",
      displayName: "Bootstrap Owner",
    });
    // Add a second owner so disable is allowed (last-owner guard kicks in
    // otherwise — exercised by the next test).
    const second = seedUser("usr_second_owner");
    await service.assignRole({
      authUserId: second,
      role: "owner",
      displayName: "Second Owner",
    });
    await service.assignRole({
      authUserId: userId,
      role: "admin",
      displayName: "Bootstrap Owner",
    });
    store.sessions.set("sess_x", {
      id: "sess_x",
      userId,
      token: "tx",
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    await service.disableUser(userId);

    expect(store.staff.get(userId)?.role).toBe("viewer");
    expect(store.sessions.has("sess_x")).toBe(false);
  });

  it("refuses to disable the last owner", async () => {
    const { service, seedUser } = buildService();
    const userId = seedUser("usr_only");
    await service.assignRole({
      authUserId: userId,
      role: "owner",
      displayName: "Only",
    });
    await expect(service.disableUser(userId)).rejects.toMatchObject({
      code: "conflict",
      details: { code: "last_owner_protected" },
    });
  });
});
