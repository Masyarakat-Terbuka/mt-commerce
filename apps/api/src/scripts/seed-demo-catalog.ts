/**
 * Demo-catalog-only seed runner. Invoked via `bun run db:seed:demo-catalog`.
 *
 * Useful when only the products/variants/inventory need to come back
 * (e.g. after a catalog truncate while iterating on the storefront).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import * as schema from "../db/schema/index.js";
import { seedDemoCatalog } from "../modules/catalog/seed/demo-catalog.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const log = logger.child({ module: "seed-demo-catalog" });
  const seedClient = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(seedClient, { schema });

  try {
    log.info("seeding demo catalog");
    const summary = await seedDemoCatalog(db);
    log.info({ summary }, "demo catalog seeded");
  } finally {
    await seedClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "demo catalog seed failed");
  process.exit(1);
});
