/**
 * API key flow — unit-level test of the create/use/revoke loop with
 * Argon2id hashing verified at the storage boundary.
 *
 * The key invariant we assert: the database NEVER stores plaintext. The
 * service returns the plaintext exactly once at creation, and the row's
 * `keyHash` is opaque to anything that does not have the plaintext.
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

const NOW = new Date("2026-05-07T12:00:00.000Z");

function buildRepo(): {
  repo: AuthRepository;
  apiKeys: Map<string, ApiKeyRow>;
  users: Map<string, AuthUserRow>;
} {
  const users = new Map<string, AuthUserRow>();
  const sessions = new Map<string, AuthSessionRow>();
  const staff = new Map<string, StaffProfileRow>();
  const apiKeys = new Map<string, ApiKeyRow>();

  const repo: AuthRepository = {
    async getUserById(id) {
      return users.get(id) ?? null;
    },
    async getUserByEmail(email) {
      for (const u of users.values()) if (u.email === email) return u;
      return null;
    },
    async listSessionsForUser(userId) {
      return [...sessions.values()].filter((s) => s.userId === userId);
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteSessionsForUser(userId) {
      for (const [id, s] of sessions) {
        if (s.userId === userId) sessions.delete(id);
      }
    },
    async getStaffProfile(authUserId) {
      return staff.get(authUserId) ?? null;
    },
    async upsertStaffProfile(input: NewStaffProfileRow) {
      const row: StaffProfileRow = {
        authUserId: input.authUserId,
        role: input.role,
        displayName: input.displayName,
        createdAt: NOW,
        updatedAt: NOW,
      };
      staff.set(input.authUserId, row);
      return row;
    },
    async hasAnyStaff() {
      return staff.size > 0;
    },
    async lockStaffNamespace() {
      // No-op for unit tests.
    },
    async countStaffByRole(role) {
      return [...staff.values()].filter((s) => s.role === role).length;
    },
    async withTransaction(fn) {
      return fn(repo);
    },
    async insertApiKey(row: NewApiKeyRow) {
      const apiKey: ApiKeyRow = {
        id: row.id,
        userId: row.userId,
        name: row.name,
        keyHash: row.keyHash,
        scopes: (row.scopes as string[] | undefined) ?? [],
        lastUsedAt: row.lastUsedAt ?? null,
        createdAt: NOW,
        revokedAt: null,
      };
      apiKeys.set(apiKey.id, apiKey);
      return apiKey;
    },
    async getApiKeyById(id) {
      return apiKeys.get(id) ?? null;
    },
    async getActiveApiKeyById(id) {
      const row = apiKeys.get(id);
      if (!row || row.revokedAt !== null) return null;
      return row;
    },
    async listApiKeysForUser(userId) {
      return [...apiKeys.values()].filter((k) => k.userId === userId);
    },
    async touchApiKey(id) {
      const e = apiKeys.get(id);
      if (!e || e.revokedAt !== null) return false;
      apiKeys.set(id, { ...e, lastUsedAt: NOW });
      return true;
    },
    async revokeApiKey(id) {
      const e = apiKeys.get(id);
      if (!e || e.revokedAt !== null) return;
      apiKeys.set(id, { ...e, revokedAt: NOW });
    },
  };

  return { repo, apiKeys, users };
}

describe("API key lifecycle", () => {
  it("creates → verifies → revokes, and never stores plaintext", async () => {
    const { repo, apiKeys, users } = buildRepo();
    users.set("usr_1", {
      id: "usr_1",
      email: "u@example.com",
      emailVerified: true,
      name: "U",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = new AuthServiceImpl(repo);

    const created = await service.createApiKey({
      userId: "usr_1",
      name: "Midtrans webhooks",
      scopes: ["webhooks:receive"],
    });

    // Plaintext shape: <id>.<secret>
    expect(created.plaintext.startsWith(`${created.apiKey.id}.`)).toBe(true);

    // Stored row must NOT be the plaintext.
    const row = apiKeys.get(created.apiKey.id);
    expect(row?.keyHash).toBeDefined();
    expect(row?.keyHash).not.toBe(created.plaintext);
    expect(row?.keyHash.length).toBeGreaterThan(20);
    // Never store the secret half — nothing in keyHash should literally
    // contain it.
    const secret = created.plaintext.split(".").slice(1).join(".");
    expect(row?.keyHash.includes(secret)).toBe(false);

    // Verify roundtrip — the plaintext must validate.
    const verified = await service.verifyApiKey(created.plaintext);
    expect(verified).not.toBeNull();
    expect(verified?.user.id).toBe("usr_1");
    expect(verified?.apiKey.id).toBe(created.apiKey.id);

    // A wrong secret must not validate.
    const tampered = `${created.apiKey.id}.WRONGSECRET`;
    const wrong = await service.verifyApiKey(tampered);
    expect(wrong).toBeNull();

    // Revoke. Subsequent verifies must fail even with the correct plaintext.
    await service.revokeApiKey(created.apiKey.id);
    const afterRevoke = await service.verifyApiKey(created.plaintext);
    expect(afterRevoke).toBeNull();

    // Double-revoke surfaces a conflict.
    await expect(service.revokeApiKey(created.apiKey.id)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects createApiKey when the user does not exist", async () => {
    const { repo } = buildRepo();
    const service = new AuthServiceImpl(repo);
    await expect(
      service.createApiKey({
        userId: "usr_missing",
        name: "x",
        scopes: ["catalog:read"],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns null for malformed bearer (no dot)", async () => {
    const { repo, users } = buildRepo();
    users.set("usr_1", {
      id: "usr_1",
      email: "u@example.com",
      emailVerified: true,
      name: "U",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = new AuthServiceImpl(repo);
    expect(await service.verifyApiKey("nodothere")).toBeNull();
    expect(await service.verifyApiKey("apik_x.")).toBeNull();
    expect(await service.verifyApiKey(".secret")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B3 — race between an in-flight verifyApiKey and a concurrent revoke.
// The verify path must NOT succeed if the row is revoked between the
// initial fetch and the (last-used) touch, and `touchApiKey` must NOT
// stamp `last_used_at` on a revoked row.
// ---------------------------------------------------------------------------

describe("API key verify/revoke race", () => {
  it("rejects a verify whose row was revoked between fetch and touch", async () => {
    // The fake repo below simulates the race: between the verify-time
    // fetch (`getActiveApiKeyById`) and the touch, a concurrent revoke
    // sets `revoked_at`. The production fix uses `RETURNING id` on the
    // touch with `AND revoked_at IS NULL`; here we simulate by calling
    // revoke between two repo hooks. Net assertion: verifyApiKey returns
    // null and the touched row's `last_used_at` stays null.
    const users = new Map<string, AuthUserRow>();
    const sessions = new Map<string, AuthSessionRow>();
    const staff = new Map<string, StaffProfileRow>();
    const apiKeys = new Map<string, ApiKeyRow>();

    users.set("usr_1", {
      id: "usr_1",
      email: "u@example.com",
      emailVerified: true,
      name: "U",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    let raceTriggered = false;
    const baseRepo: AuthRepository = {
      async getUserById(id) {
        return users.get(id) ?? null;
      },
      async getUserByEmail() {
        return null;
      },
      async listSessionsForUser(userId) {
        return [...sessions.values()].filter((s) => s.userId === userId);
      },
      async deleteSession(id) {
        sessions.delete(id);
      },
      async deleteSessionsForUser(userId) {
        for (const [id, s] of sessions) {
          if (s.userId === userId) sessions.delete(id);
        }
      },
      async getStaffProfile(authUserId) {
        return staff.get(authUserId) ?? null;
      },
      async upsertStaffProfile() {
        throw new Error("not used");
      },
      async hasAnyStaff() {
        return staff.size > 0;
      },
      async lockStaffNamespace() {
        // unused
      },
      async countStaffByRole() {
        return 0;
      },
      async withTransaction(fn) {
        return fn(baseRepo);
      },
      async insertApiKey(row: NewApiKeyRow) {
        const apiKey: ApiKeyRow = {
          id: row.id,
          userId: row.userId,
          name: row.name,
          keyHash: row.keyHash,
          scopes: (row.scopes as string[] | undefined) ?? [],
          lastUsedAt: row.lastUsedAt ?? null,
          createdAt: NOW,
          revokedAt: null,
        };
        apiKeys.set(apiKey.id, apiKey);
        return apiKey;
      },
      async getApiKeyById(id) {
        return apiKeys.get(id) ?? null;
      },
      async getActiveApiKeyById(id) {
        const row = apiKeys.get(id);
        if (!row || row.revokedAt !== null) return null;
        // Right between the verify-time fetch and the eventual touch,
        // simulate a concurrent revoke landing.
        if (!raceTriggered) {
          raceTriggered = true;
          const e = apiKeys.get(id);
          if (e) apiKeys.set(id, { ...e, revokedAt: NOW });
        }
        return row;
      },
      async listApiKeysForUser() {
        return [];
      },
      async touchApiKey(id) {
        // Production semantic: only update if the row is still active.
        // Returns false when the row was revoked between fetch and touch.
        const e = apiKeys.get(id);
        if (!e || e.revokedAt !== null) return false;
        apiKeys.set(id, { ...e, lastUsedAt: NOW });
        return true;
      },
      async revokeApiKey(id) {
        const e = apiKeys.get(id);
        if (!e || e.revokedAt !== null) return;
        apiKeys.set(id, { ...e, revokedAt: NOW });
      },
    };

    const service = new AuthServiceImpl(baseRepo);

    const created = await service.createApiKey({
      userId: "usr_1",
      name: "race",
      scopes: ["catalog:read"],
    });

    const result = await service.verifyApiKey(created.plaintext);
    // Race resolved cleanly — no auth, no thrown exception.
    expect(result).toBeNull();

    // Audit trail invariant: the row's last_used_at must NOT have been
    // stamped after revocation.
    const stored = apiKeys.get(created.apiKey.id);
    expect(stored?.revokedAt).not.toBeNull();
    expect(stored?.lastUsedAt).toBeNull();
  });
});
