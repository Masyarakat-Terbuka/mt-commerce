/**
 * Seed a demo staff owner for local development.
 *
 *   $ bun run src/scripts/seed-demo-owner.ts <email> <password>
 *
 * Two-step flow:
 *   1. Sign the user up through Better Auth (`api.signUpEmail`). This
 *      populates `auth_users` and the linked `users` row exactly the same
 *      way a real storefront `/sign-up` would.
 *   2. Promote the freshly-created auth user to staff role `owner` via
 *      `provisionOwner`, the existing pure helper used by the
 *      `provision-owner` CLI.
 *
 * Idempotent: if the user already exists, the sign-up step is treated as
 * a no-op and the script falls through to the provision step. If the
 * user is already an owner, the provision step is itself a no-op.
 *
 * The script exists separately from `provision-owner.ts` because that
 * one only PROMOTES existing accounts — by design, it refuses to create
 * passwords from CLI args (production owners always sign up themselves).
 * For local dev we want a single command to take an empty database to a
 * sign-in-able admin; this script provides exactly that and stays out of
 * the production code path.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import * as schema from "../db/schema/index.js";
import { authUsers, staffProfiles } from "../db/schema/index.js";
import { getAuth } from "../modules/auth/better-auth.js";
import { provisionOwner } from "./provision-owner.js";
import { authService } from "../modules/auth/service.js";

async function main(): Promise<void> {
  const [email, password] = Bun.argv.slice(2);
  if (!email || !password) {
    process.stderr.write(
      "Usage: bun run src/scripts/seed-demo-owner.ts <email> <password>\n",
    );
    process.exit(1);
  }
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const log = logger.child({ module: "seed-demo-owner" });
  const seedClient = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(seedClient, { schema });

  try {
    // 1. Sign up via Better Auth. Treat a "user already exists" response
    //    as a benign duplicate; we just want the auth_users row in place.
    log.info({ email }, "ensuring auth user exists");
    const auth = getAuth();
    let signedUp = false;
    try {
      await auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "Demo Owner",
        },
      });
      signedUp = true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message.toLowerCase() : String(err);
      // Better Auth surfaces an `APIError` with a "user already exists"-shaped
      // message. We don't import APIError directly to avoid a peer-dep on
      // its internals — the message check is good enough for a dev seed.
      if (
        message.includes("already exists") ||
        message.includes("invalid_email_or_password") ||
        message.includes("invalid email") // some better-auth variants
      ) {
        log.info({ email }, "auth user already exists, continuing");
      } else {
        throw err;
      }
    }
    if (signedUp) {
      log.info({ email }, "auth user created");
    }

    // 2. Promote to owner via the existing pure helper. Re-uses the
    //    transactional last-owner / first-staff invariants in
    //    `AuthService.assignRole` so the demo path matches production.
    log.info({ email }, "promoting to staff owner");
    const outcome = await provisionOwner({
      email,
      autoConfirm: true,
      deps: {
        async findUserByEmailCI(e) {
          const rows = await db
            .select()
            .from(authUsers)
            .where(sql`lower(${authUsers.email}) = lower(${e})`)
            .limit(1);
          return rows[0] ?? null;
        },
        async getStaffProfile(authUserId) {
          const rows = await db
            .select()
            .from(staffProfiles)
            .where(eq(staffProfiles.authUserId, authUserId))
            .limit(1);
          return rows[0] ?? null;
        },
        authService,
        async readLine() {
          // autoConfirm is true; this never fires.
          return "";
        },
        stdout: (line) => {
          log.info(line);
        },
        stderr: (line) => {
          log.warn(line);
        },
      },
    });

    log.info({ outcome: outcome.kind, email }, "seed-demo-owner complete");
  } finally {
    await seedClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "seed-demo-owner failed");
  process.exit(1);
});
