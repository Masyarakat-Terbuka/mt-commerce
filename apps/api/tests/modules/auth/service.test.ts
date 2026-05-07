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
import { verifySecret } from "../../../src/modules/auth/hash.js";
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
    async hasAnyStaff() {
      return store.staff.size > 0;
    },
    async countStaffByRole(role) {
      return [...store.staff.values()].filter((s) => s.role === role).length;
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
      if (!existing) return;
      store.apiKeys.set(id, { ...existing, lastUsedAt: FIXED_NOW });
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
    await service.assignRole({
      authUserId: userId,
      role: "owner",
      displayName: "Owner v1",
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
