/**
 * Drizzle client backed by `postgres` (postgres-js).
 *
 * Pool sizing: `max: 10` is a starting point that suits a single API process
 * on a small VPS. Production deployments behind a connection pooler (PgBouncer
 * in transaction mode is the typical choice) should set `max` per the pooler's
 * recommendation rather than per-process.
 *
 * `idle_timeout: 20` and `max_lifetime: 60 * 30` keep the pool from hoarding
 * connections during quiet periods and rotate connections every 30 minutes,
 * which avoids issues with long-lived TCP sockets behind some load balancers.
 *
 * `prepare: false` is set because some pool implementations (notably PgBouncer
 * in transaction mode) do not support session-level prepared statements. The
 * cost is small for this workload; revisit if a hot query benefits from it.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../lib/env.js";
import * as schema from "./schema/index.js";

if (!env.databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. The API requires a Postgres connection string.",
  );
}

export const queryClient = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });

/**
 * Lightweight liveness probe for the database. Returns true on success and
 * false on any connection or query failure. Does not throw — `/ready` decides
 * what to do with the boolean.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await queryClient`select 1`;
    return true;
  } catch {
    return false;
  }
}
