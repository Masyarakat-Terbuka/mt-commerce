/**
 * `provision-owner` — CLI to promote an existing auth user to the `owner`
 * role. Replaces the manual `INSERT INTO staff_profiles ...` workflow that
 * used to live in `docs/api/authentication.md`.
 *
 * Usage:
 *   bun --filter '@mt-commerce/api' provision-owner <email> [--yes|-y]
 *
 * Behavior:
 *   - Looks up `auth_users` by email (case-insensitive).
 *   - If no user, prints a clear error and exits 1.
 *   - If the user is already `owner`, prints an idempotent message and exits 0.
 *   - If the user has a different staff role, prompts for confirmation
 *     unless `--yes`/`-y` is passed.
 *   - Otherwise (no profile yet), creates a staff_profile with role=owner
 *     and the user's name as display_name.
 *
 * The actual assignment is delegated to `AuthService.assignRole`, which:
 *   - Wraps lock + check + write in a single transaction (last-owner /
 *     first-staff invariants).
 *   - Throws AppError subclasses on validation/conflict.
 *
 * The script is split into a pure `provisionOwner({ ... })` function and a
 * thin CLI wrapper so the logic can be unit-tested without touching argv,
 * stdin, the DB, or `process.exit`.
 */
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../db/client.js";
import { AppError } from "../lib/errors.js";
import { authService as defaultAuthService } from "../modules/auth/service.js";
import type { AuthService } from "../modules/auth/service.js";
import {
  authUsers,
  staffProfiles,
  type AuthUserRow,
  type StaffProfileRow,
} from "../db/schema/index.js";
import type * as schema from "../db/schema/index.js";

type Db = PostgresJsDatabase<typeof schema>;

// ----------------------------------------------------------------------------
// Pure function — no argv, no stdin, no exit. All side-effects via `deps`.
// ----------------------------------------------------------------------------

export type ProvisionOutcome =
  | { kind: "missing_user"; email: string }
  | { kind: "already_owner"; email: string }
  | { kind: "aborted"; email: string; previousRole: string }
  | { kind: "promoted"; email: string; previousRole: string }
  | { kind: "created"; email: string };

export interface ProvisionOwnerDeps {
  /**
   * Case-insensitive email lookup against `auth_users`. Separate from the
   * AuthRepository's `getUserByEmail` (which is case-sensitive) so this
   * script does not need to extend the public repo surface for one caller.
   */
  findUserByEmailCI(email: string): Promise<AuthUserRow | null>;
  /** Returns the existing staff profile, or null. */
  getStaffProfile(authUserId: string): Promise<StaffProfileRow | null>;
  /** Used to perform the actual assignment. */
  authService: Pick<AuthService, "assignRole">;
  /** Read one line from stdin for the confirmation prompt. */
  readLine(prompt: string): Promise<string>;
  /** Write a line to stdout. */
  stdout(line: string): void;
  /** Write a line to stderr. */
  stderr(line: string): void;
}

export interface ProvisionOwnerInput {
  email: string;
  /** When true, skip the y/N prompt for non-owner→owner promotions. */
  autoConfirm: boolean;
  deps: ProvisionOwnerDeps;
}

export async function provisionOwner(
  input: ProvisionOwnerInput,
): Promise<ProvisionOutcome> {
  const email = input.email.trim();
  if (!isValidEmail(email)) {
    // Surface as AppError so the CLI wrapper formats it like every other
    // operator-facing error.
    throw new InvalidEmailError(email);
  }

  const user = await input.deps.findUserByEmailCI(email);
  if (!user) {
    input.deps.stderr(
      `No user with email ${email} exists. Sign them up via POST /api/auth/sign-up/email or the storefront, then run this script again.`,
    );
    return { kind: "missing_user", email };
  }

  const existing = await input.deps.getStaffProfile(user.id);
  if (existing?.role === "owner") {
    input.deps.stdout(`${email} is already owner`);
    return { kind: "already_owner", email };
  }

  if (existing) {
    if (!input.autoConfirm) {
      const answer = await input.deps.readLine(
        `User ${email} currently has role ${existing.role}. Promote to owner? [y/N] `,
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized !== "y" && normalized !== "yes") {
        input.deps.stdout("Aborted.");
        return { kind: "aborted", email, previousRole: existing.role };
      }
    }
    await input.deps.authService.assignRole({
      authUserId: user.id,
      role: "owner",
      displayName: existing.displayName,
    });
    input.deps.stdout(`Owner role assigned to ${email}`);
    return { kind: "promoted", email, previousRole: existing.role };
  }

  // No staff_profile yet — create with the user's name as display_name.
  await input.deps.authService.assignRole({
    authUserId: user.id,
    role: "owner",
    displayName: user.name,
  });
  input.deps.stdout(`Owner role assigned to ${email}`);
  return { kind: "created", email };
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

/**
 * Pragmatic email check. Same shape as the Zod schema's `.email()` constraint
 * for the auth module: a single `@`, non-empty local and domain, and a `.`
 * in the domain. Good enough for an operator-typed CLI argument; the canonical
 * validation still happens in `auth_users` (Better Auth) on sign-up.
 */
export function isValidEmail(value: string): boolean {
  if (value.length < 3 || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  if (/\s/.test(value)) return false;
  return true;
}

export class InvalidEmailError extends AppError {
  constructor(value: string) {
    super({
      code: "validation_error",
      message: `Invalid email: ${value}`,
      status: 400,
      details: { email: value },
    });
    this.name = "InvalidEmailError";
  }
}

// ----------------------------------------------------------------------------
// Default deps wiring (used by the CLI wrapper, not the tests)
// ----------------------------------------------------------------------------

export function buildDefaultDeps(db: Db = defaultDb): ProvisionOwnerDeps {
  return {
    async findUserByEmailCI(email) {
      // Case-insensitive equality. `auth_users.email` has a unique index on
      // the raw column, so `lower(email) = lower($1)` is a seq-scan-leaning
      // query — fine for this single-row, operator-driven lookup.
      const [row] = await db
        .select()
        .from(authUsers)
        .where(sql`lower(${authUsers.email}) = lower(${email})`)
        .limit(1);
      return row ?? null;
    },
    async getStaffProfile(authUserId) {
      const [row] = await db
        .select()
        .from(staffProfiles)
        .where(eq(staffProfiles.authUserId, authUserId))
        .limit(1);
      return row ?? null;
    },
    authService: defaultAuthService,
    readLine,
    stdout(line) {
      process.stdout.write(`${line}\n`);
    },
    stderr(line) {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * Read a single line from stdin. Bun's stdin is an AsyncIterable of Uint8Array
 * chunks; we accumulate until a newline and return the line without it.
 *
 * If stdin reaches EOF before a newline (e.g. piped input with no trailing
 * newline), we still return whatever we got. If stdin is closed before any
 * input, returns the empty string — the caller treats "" as "not yes".
 */
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      return buffer.slice(0, newline).replace(/\r$/, "");
    }
  }
  return buffer.replace(/\r$/, "");
}

// ----------------------------------------------------------------------------
// Argv parsing — pure helper so it is testable too.
// ----------------------------------------------------------------------------

export interface ParsedArgs {
  email: string | null;
  autoConfirm: boolean;
  /** Set when the args were structurally invalid. */
  errorMessage: string | null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let autoConfirm = false;
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") {
      autoConfirm = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        email: null,
        autoConfirm: false,
        errorMessage: `Unknown flag: ${arg}`,
      };
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    return {
      email: null,
      autoConfirm: false,
      errorMessage:
        "Usage: bun --filter '@mt-commerce/api' provision-owner <email> [--yes|-y]",
    };
  }
  if (positional.length > 1) {
    return {
      email: null,
      autoConfirm: false,
      errorMessage: `Expected exactly one email argument, got ${String(positional.length)}.`,
    };
  }
  return {
    email: positional[0] ?? null,
    autoConfirm,
    errorMessage: null,
  };
}

// ----------------------------------------------------------------------------
// Thin CLI wrapper. Tests import `provisionOwner` and `parseArgs` directly,
// not this main(), to avoid coupling to Bun.argv / process.exit.
// ----------------------------------------------------------------------------

async function main(): Promise<number> {
  // `Bun.argv` mirrors `process.argv`: [bun, scriptPath, ...userArgs].
  const userArgs = Bun.argv.slice(2);
  const parsed = parseArgs(userArgs);
  if (parsed.errorMessage !== null || parsed.email === null) {
    process.stderr.write(
      `${parsed.errorMessage ?? "Missing email argument"}\n`,
    );
    return 1;
  }

  try {
    const outcome = await provisionOwner({
      email: parsed.email,
      autoConfirm: parsed.autoConfirm,
      deps: buildDefaultDeps(),
    });
    return outcome.kind === "missing_user" ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof AppError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

// Run only when invoked directly. Bun and Node both set `import.meta.main`
// for the entry module under recent versions; the explicit URL fallback
// keeps the script runnable under tooling that does not.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
