/**
 * `AuthService` — public business operations the rest of the API uses.
 *
 * Operations that flow through Better Auth (register, login, verify, reset)
 * are NOT re-implemented here; the Better Auth handler is mounted directly
 * on the Hono app and owns those routes. This service covers what mt-commerce
 * needs *on top* of Better Auth:
 *
 *   - Staff role assignment (the first staff user becomes `owner`).
 *   - Session listing and revocation for the operator-facing admin UI.
 *   - API-key issuance and verification, including the Argon2id hash check.
 *
 * Per ADR-0005, no other module imports this file directly — they use the
 * `authService` singleton re-exported from `./index.ts`.
 */
import { id, rawUlid } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { hashSecret, verifySecret } from "./hash.js";
import {
  createAuthRepository,
  type AuthRepository,
} from "./repository.js";
import {
  SCOPES,
  type ApiKey,
  type AuthSession,
  type AuthUser,
  type Role,
  type Scope,
  type StaffProfile,
} from "./types.js";

export interface AuthService {
  // Staff
  /**
   * Look up the staff profile for an auth user, or null if they are not
   * staff. Used by the role middleware.
   */
  getStaffProfile(authUserId: string): Promise<StaffProfile | null>;
  /**
   * Assign or update a staff role. The first call (when no staff exist) must
   * be `owner` — this is enforced here, NOT in the route, so seed scripts
   * cannot bypass it. Subsequent calls accept any role.
   */
  assignRole(input: {
    authUserId: string;
    role: Role;
    displayName: string;
  }): Promise<StaffProfile>;

  // Sessions
  listSessions(userId: string): Promise<AuthSession[]>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(userId: string): Promise<void>;

  // API keys
  /**
   * Create a new API key. The plaintext key is returned ONCE in the
   * response; the database stores only an Argon2id hash. The wire format
   * for the bearer header is `<id>.<secret>`.
   */
  createApiKey(input: {
    userId: string;
    name: string;
    scopes: Scope[];
  }): Promise<{ apiKey: ApiKey; plaintext: string }>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
  revokeApiKey(id: string): Promise<void>;
  /**
   * Verify a `<id>.<secret>` bearer string. Returns the matching key + user
   * on success, or `null` for any failure (unknown id, revoked, hash
   * mismatch). Never throws on the auth path so the caller can render a
   * uniform 401.
   */
  verifyApiKey(bearer: string): Promise<{
    apiKey: ApiKey;
    user: AuthUser;
  } | null>;
}

export class AuthServiceImpl implements AuthService {
  constructor(private readonly repo: AuthRepository) {}

  // ------------------------------------------------------------
  // Staff
  // ------------------------------------------------------------

  async getStaffProfile(authUserId: string): Promise<StaffProfile | null> {
    const row = await this.repo.getStaffProfile(authUserId);
    return row ? toStaffProfile(row) : null;
  }

  async assignRole(input: {
    authUserId: string;
    role: Role;
    displayName: string;
  }): Promise<StaffProfile> {
    const user = await this.repo.getUserById(input.authUserId);
    if (!user) {
      throw new NotFoundError("Auth user not found.", {
        authUserId: input.authUserId,
      });
    }

    // First-staff-must-be-owner rule. Without it, a seed script could quietly
    // create a non-owner first staff and lock the platform out of every
    // owner-only operation.
    const hasAnyStaff = await this.repo.hasAnyStaff();
    if (!hasAnyStaff && input.role !== "owner") {
      throw new ValidationError(
        "The first staff user must have the `owner` role.",
        { providedRole: input.role },
      );
    }

    const row = await this.repo.upsertStaffProfile({
      authUserId: input.authUserId,
      role: input.role,
      displayName: input.displayName,
    });
    return toStaffProfile(row);
  }

  // ------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------

  async listSessions(userId: string): Promise<AuthSession[]> {
    const rows = await this.repo.listSessionsForUser(userId);
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
      ipAddress: row.ipAddress ?? null,
      userAgent: row.userAgent ?? null,
      createdAt: row.createdAt,
    }));
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.repo.deleteSession(sessionId);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.repo.deleteSessionsForUser(userId);
  }

  // ------------------------------------------------------------
  // API keys
  // ------------------------------------------------------------

  async createApiKey(input: {
    userId: string;
    name: string;
    scopes: Scope[];
  }): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const user = await this.repo.getUserById(input.userId);
    if (!user) {
      throw new NotFoundError("Auth user not found.", {
        userId: input.userId,
      });
    }

    // Validate scopes against the known set. The Zod schema validates at the
    // boundary, but services are also called directly (seed scripts, tests)
    // and we want a uniform rejection.
    const allowed = new Set<string>(SCOPES);
    const unknown = input.scopes.filter((s) => !allowed.has(s));
    if (unknown.length > 0) {
      throw new ValidationError("Unknown scope(s) requested.", {
        scopes: unknown,
        allowed: [...SCOPES],
      });
    }
    if (input.scopes.length === 0) {
      throw new ValidationError("At least one scope is required.");
    }

    const apiKeyId = id("apik");
    // The secret is a fresh ULID — 128 bits of entropy, URL-safe, easy to
    // copy/paste. Combined with the id prefix, the bearer string is
    // unambiguous and easy to log without exposing the secret half.
    const secret = rawUlid();
    const keyHash = await hashSecret(secret);

    const row = await this.repo.insertApiKey({
      id: apiKeyId,
      userId: input.userId,
      name: input.name,
      keyHash,
      scopes: input.scopes,
    });

    return {
      apiKey: toApiKey(row),
      plaintext: `${apiKeyId}.${secret}`,
    };
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const rows = await this.repo.listApiKeysForUser(userId);
    return rows.map((row) => toApiKey(row));
  }

  async revokeApiKey(id: string): Promise<void> {
    const existing = await this.repo.getApiKeyById(id);
    if (!existing) {
      throw new NotFoundError("API key not found.", { id });
    }
    if (existing.revokedAt !== null) {
      // Idempotent: already revoked is not an error, but also not a no-op
      // we want to silently skip — surface a conflict so the caller knows
      // they raced themselves.
      throw new ConflictError("API key is already revoked.", { id });
    }
    await this.repo.revokeApiKey(id);
  }

  async verifyApiKey(bearer: string): Promise<{
    apiKey: ApiKey;
    user: AuthUser;
  } | null> {
    // Bearer format `<apik_id>.<secret>` — we split on the first dot only,
    // because both halves are ULID-based and contain no dots. A malformed
    // bearer becomes `null`, never an exception.
    const dot = bearer.indexOf(".");
    if (dot < 0) return null;
    const id = bearer.slice(0, dot);
    const secret = bearer.slice(dot + 1);
    if (!id || !secret) return null;

    const row = await this.repo.getActiveApiKeyById(id);
    if (!row) return null;

    const ok = await verifySecret(row.keyHash, secret);
    if (!ok) return null;

    const user = await this.repo.getUserById(row.userId);
    if (!user) return null;

    // Best-effort touch — failure to update `last_used_at` should not block
    // the request. Run it sync since we are already on the request path,
    // but swallow errors.
    try {
      await this.repo.touchApiKey(id);
    } catch {
      // ignore
    }

    return {
      apiKey: toApiKey(row),
      user: toAuthUser(user),
    };
  }
}

// ---------------------------------------------------------------
// Domain mappers
// ---------------------------------------------------------------

function toStaffProfile(row: {
  authUserId: string;
  role: Role;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}): StaffProfile {
  return {
    authUserId: row.authUserId,
    role: row.role,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toApiKey(row: {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKey {
  // Coerce to the typed `Scope[]`. Rows could in principle contain unknown
  // scope strings if the SCOPES set has been narrowed since the row was
  // written; we filter to the known set to keep the wire shape sound.
  const allowed = new Set<string>(SCOPES);
  const scopes = row.scopes.filter((s): s is Scope => allowed.has(s));
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scopes,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? null,
  };
}

function toAuthUser(row: {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    name: row.name,
    image: row.image ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Default singleton wired to the runtime database. Tests construct
 * `AuthServiceImpl` directly with a fake repository.
 */
export const authService: AuthService = new AuthServiceImpl(
  createAuthRepository(),
);
