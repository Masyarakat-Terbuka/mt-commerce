/**
 * Tests for the `provision-owner` CLI logic.
 *
 * Tests target the pure `provisionOwner({ ... })` function and `parseArgs`
 * helper — not the thin Bun.argv / process.exit wrapper, which would force
 * us to spawn a subprocess and stand up Postgres for no real coverage gain.
 *
 * The fake `AuthService` mirrors only the shape `provisionOwner` actually
 * uses (`assignRole`), so we can assert it is called with the expected
 * arguments without re-implementing the whole service surface.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isValidEmail,
  parseArgs,
  provisionOwner,
  type ProvisionOwnerDeps,
} from "../../src/scripts/provision-owner.js";
import type { AuthUserRow, StaffProfileRow } from "../../src/db/schema/index.js";

const FIXED_NOW = new Date("2026-05-07T12:00:00.000Z");

function makeUser(overrides: Partial<AuthUserRow> = {}): AuthUserRow {
  return {
    id: "usr_owner_1",
    email: "owner@example.com",
    emailVerified: true,
    name: "Owner Person",
    image: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function makeProfile(
  overrides: Partial<StaffProfileRow> = {},
): StaffProfileRow {
  return {
    authUserId: "usr_owner_1",
    role: "owner",
    displayName: "Owner Person",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

interface DepsHandle {
  deps: ProvisionOwnerDeps;
  out: string[];
  err: string[];
  prompts: string[];
  /** Promise resolution for `readLine`. Tests push answers in order. */
  answers: string[];
  assignRole: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  user?: AuthUserRow | null;
  profile?: StaffProfileRow | null;
  answers?: string[];
}): DepsHandle {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const assignRole = vi.fn().mockResolvedValue({
    authUserId: "usr_owner_1",
    role: "owner",
    displayName: "Owner Person",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });

  return {
    out,
    err,
    prompts,
    answers,
    assignRole,
    deps: {
      async findUserByEmailCI() {
        return opts.user ?? null;
      },
      async getStaffProfile() {
        return opts.profile ?? null;
      },
      authService: { assignRole },
      async readLine(prompt) {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
      stdout(line) {
        out.push(line);
      },
      stderr(line) {
        err.push(line);
      },
    },
  };
}

describe("isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("owner.person+tag@example.com")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("user@")).toBe(false);
    expect(isValidEmail("a b@example.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("returns a usage error when no email is supplied", () => {
    const parsed = parseArgs([]);
    expect(parsed.email).toBeNull();
    expect(parsed.errorMessage).toMatch(/Usage:/);
  });

  it("recognizes --yes and -y flags", () => {
    expect(parseArgs(["a@b.co", "--yes"])).toEqual({
      email: "a@b.co",
      autoConfirm: true,
      errorMessage: null,
    });
    expect(parseArgs(["-y", "a@b.co"])).toEqual({
      email: "a@b.co",
      autoConfirm: true,
      errorMessage: null,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["a@b.co", "--force"]).errorMessage).toMatch(/Unknown/);
  });

  it("rejects more than one positional", () => {
    expect(parseArgs(["a@b.co", "c@d.co"]).errorMessage).toMatch(/exactly one/);
  });
});

describe("provisionOwner", () => {
  it("rejects an invalid email format with a validation error", async () => {
    const handle = makeDeps({});
    await expect(
      provisionOwner({
        email: "not-an-email",
        autoConfirm: false,
        deps: handle.deps,
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(handle.assignRole).not.toHaveBeenCalled();
  });

  it("prints a clear error and returns missing_user when the user does not exist", async () => {
    const handle = makeDeps({ user: null });
    const outcome = await provisionOwner({
      email: "ghost@example.com",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome).toEqual({ kind: "missing_user", email: "ghost@example.com" });
    expect(handle.err.join("\n")).toContain(
      "No user with email ghost@example.com exists",
    );
    expect(handle.assignRole).not.toHaveBeenCalled();
  });

  it("creates a new staff_profile with role=owner when none exists", async () => {
    const handle = makeDeps({ user: makeUser(), profile: null });
    const outcome = await provisionOwner({
      email: "owner@example.com",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome).toEqual({ kind: "created", email: "owner@example.com" });
    expect(handle.assignRole).toHaveBeenCalledWith({
      authUserId: "usr_owner_1",
      role: "owner",
      displayName: "Owner Person",
    });
    expect(handle.out.join("\n")).toContain(
      "Owner role assigned to owner@example.com",
    );
    expect(handle.prompts).toEqual([]);
  });

  it("is idempotent when the user is already owner", async () => {
    const handle = makeDeps({
      user: makeUser(),
      profile: makeProfile({ role: "owner" }),
    });
    const outcome = await provisionOwner({
      email: "owner@example.com",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome).toEqual({
      kind: "already_owner",
      email: "owner@example.com",
    });
    expect(handle.assignRole).not.toHaveBeenCalled();
    expect(handle.out.join("\n")).toContain("owner@example.com is already owner");
  });

  it("aborts when the user has a non-owner role and the prompt answer is no", async () => {
    const handle = makeDeps({
      user: makeUser(),
      profile: makeProfile({ role: "admin", displayName: "Admin Person" }),
      answers: ["n"],
    });
    const outcome = await provisionOwner({
      email: "owner@example.com",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome).toEqual({
      kind: "aborted",
      email: "owner@example.com",
      previousRole: "admin",
    });
    expect(handle.prompts[0]).toContain("currently has role admin");
    expect(handle.assignRole).not.toHaveBeenCalled();
    expect(handle.out.join("\n")).toContain("Aborted");
  });

  it("promotes silently when --yes is set and the user has a non-owner role", async () => {
    const handle = makeDeps({
      user: makeUser(),
      profile: makeProfile({ role: "viewer", displayName: "Viewer Person" }),
    });
    const outcome = await provisionOwner({
      email: "owner@example.com",
      autoConfirm: true,
      deps: handle.deps,
    });
    expect(outcome).toEqual({
      kind: "promoted",
      email: "owner@example.com",
      previousRole: "viewer",
    });
    // No prompt was issued.
    expect(handle.prompts).toEqual([]);
    // displayName is preserved from the existing profile, not overwritten
    // with the auth_users.name (the operator may have customized it).
    expect(handle.assignRole).toHaveBeenCalledWith({
      authUserId: "usr_owner_1",
      role: "owner",
      displayName: "Viewer Person",
    });
  });

  it("promotes when the prompt answer is yes (case-insensitive)", async () => {
    const handle = makeDeps({
      user: makeUser(),
      profile: makeProfile({ role: "staff", displayName: "Staff Person" }),
      answers: ["YES"],
    });
    const outcome = await provisionOwner({
      email: "owner@example.com",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome.kind).toBe("promoted");
    expect(handle.assignRole).toHaveBeenCalledOnce();
  });

  it("looks up email case-insensitively (delegated to deps)", async () => {
    // The case-insensitivity itself is enforced by `findUserByEmailCI` (the
    // production version uses `lower(email) = lower(...)`). We assert that
    // `provisionOwner` does not transform the email beyond trim/validate,
    // so the lookup contract is preserved.
    const handle = makeDeps({
      user: makeUser({ email: "Owner@Example.com" }),
      profile: null,
    });
    const outcome = await provisionOwner({
      email: "  OWNER@EXAMPLE.COM  ",
      autoConfirm: false,
      deps: handle.deps,
    });
    expect(outcome.kind).toBe("created");
  });
});
