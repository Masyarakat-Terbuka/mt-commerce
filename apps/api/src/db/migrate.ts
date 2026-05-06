/**
 * Migration runner. Invoked via `bun run db:migrate`.
 *
 * Uses Drizzle's migrator which reads the journal in `drizzle/migrations` and
 * applies any pending SQL files in order. Migrations are forward-only (per
 * ARCHITECTURE.md): a bug in a migration is corrected by the next migration,
 * not by rolling back.
 *
 * Run as a separate, single-purpose process so that:
 *   - it can be invoked from CI or a deploy step without booting the API
 *   - the migration connection is closed cleanly before the process exits
 *   - errors fail loudly with a non-zero exit code
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  // Migrations need a single dedicated connection, not the pool the API uses.
  const migrationClient = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(migrationClient);

  const log = logger.child({ module: "migrate" });
  log.info("running migrations");

  try {
    await migrate(db, { migrationsFolder: "./drizzle/migrations" });
    log.info("migrations complete");
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
