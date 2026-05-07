/**
 * Shipping-method seed.
 *
 * v0.1 ships with a single manual flat-rate option in IDR (Rp 15.000).
 * The seed is idempotent: a re-run does not duplicate the row.
 *
 * Idempotency strategy:
 *   - Methods are keyed on `code` (UNIQUE column). We check before
 *     inserting so the summary can distinguish "already there" from
 *     "freshly inserted".
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { id } from "@mt-commerce/core/ulid";
import { shippingMethods } from "../../../db/schema/index.js";
import type * as schema from "../../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface ShippingSeedSummary {
  methodsPresent: number;
  methodsInserted: number;
}

export async function seedDefaultShippingMethods(
  db: Db,
): Promise<ShippingSeedSummary> {
  const summary: ShippingSeedSummary = {
    methodsPresent: 0,
    methodsInserted: 0,
  };

  const [existing] = await db
    .select({ id: shippingMethods.id })
    .from(shippingMethods)
    .where(eq(shippingMethods.code, "MANUAL_FLAT"))
    .limit(1);
  if (existing) {
    summary.methodsPresent = 1;
    return summary;
  }

  await db.insert(shippingMethods).values({
    id: id("ship"),
    code: "MANUAL_FLAT",
    name: "Pengiriman Reguler (Flat)",
    providerKind: "manual",
    flatRateAmount: 15_000n,
    flatRateCurrency: "IDR",
    isActive: true,
  });
  summary.methodsInserted = 1;
  return summary;
}
