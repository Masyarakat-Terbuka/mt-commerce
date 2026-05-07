/**
 * Top-level dev seed runner. Invoked via `bun run db:seed`.
 *
 * Runs every seed in dependency order — regions first (the customer
 * module needs them in place before any address can validate), then
 * the demo catalog. Each step logs a count summary.
 *
 * Pattern follows `db/migrate.ts`:
 *   - opens a single dedicated connection (not the API pool)
 *   - exits non-zero on failure
 *   - closes the connection cleanly even on the error path
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import * as schema from "../db/schema/index.js";
import { seedRegions } from "../modules/customer/seed/regions.js";
import { seedDemoCatalog } from "../modules/catalog/seed/demo-catalog.js";
import { seedDefaultTaxRates } from "../modules/tax/seed/default-rates.js";
import { seedDefaultShippingMethods } from "../modules/shipping/seed/default-methods.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const log = logger.child({ module: "seed" });
  // Single connection is fine — seeds are not concurrent and we want to
  // close cleanly before exit.
  const seedClient = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(seedClient, { schema });

  try {
    log.info("seeding regions");
    const regionSummary = await seedRegions(db);
    log.info({ summary: regionSummary }, "regions seeded");

    log.info("seeding demo catalog");
    const catalogSummary = await seedDemoCatalog(db);
    log.info({ summary: catalogSummary }, "demo catalog seeded");

    log.info("seeding default tax rates");
    const taxSummary = await seedDefaultTaxRates(db);
    log.info({ summary: taxSummary }, "tax rates seeded");

    log.info("seeding default shipping methods");
    const shippingSummary = await seedDefaultShippingMethods(db);
    log.info({ summary: shippingSummary }, "shipping methods seeded");

    log.info("seed complete");
  } finally {
    await seedClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "seed failed");
  process.exit(1);
});
