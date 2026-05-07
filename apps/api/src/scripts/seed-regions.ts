/**
 * Regions-only seed runner. Invoked via `bun run db:seed:regions`.
 *
 * Useful when only the customer/address dropdown data needs to come
 * back (e.g. after a regions table truncate during development).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import * as schema from "../db/schema/index.js";
import { seedRegions } from "../modules/customer/seed/regions.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const log = logger.child({ module: "seed-regions" });
  const seedClient = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(seedClient, { schema });

  try {
    log.info("seeding regions");
    const summary = await seedRegions(db);
    log.info({ summary }, "regions seeded");
  } finally {
    await seedClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "regions seed failed");
  process.exit(1);
});
