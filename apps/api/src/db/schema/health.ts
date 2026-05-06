/**
 * Minimal table used by the smoke-test ping route. Exists so the API can
 * verify a real round-trip to Postgres on every deployment without depending
 * on any business module.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const healthPings = pgTable("health_pings", {
  id: text("id").primaryKey(),
  pingedAt: timestamp("pinged_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type HealthPing = typeof healthPings.$inferSelect;
export type NewHealthPing = typeof healthPings.$inferInsert;
