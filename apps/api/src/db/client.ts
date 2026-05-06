/**
 * Drizzle client backed by `postgres` (postgres-js).
 *
 * The client is lazy: it is not constructed at import time. Modules that
 * import `db` get a Proxy that materializes the real client on first access,
 * which means tests that never touch the database (the typical unit test) do
 * not need a `DATABASE_URL` and do not crash on import.
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
 *
 * Tests that *do* exercise the DB layer can override the client by calling
 * `__setDbForTesting()`. This is intentionally a module-local override rather
 * than a DI framework — at v0.1 the cost of the simpler approach is fine.
 */
import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { env } from "../lib/env.js";
import * as schema from "./schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

let queryClientInstance: Sql | undefined;
let dbInstance: Db | undefined;
/** Test-injected override. When set, `getDb()` returns this. */
let dbOverride: Db | undefined;

function buildClients(): { queryClient: Sql; db: Db } {
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The API requires a Postgres connection string.",
    );
  }
  const queryClient = postgres(env.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: false,
  });
  const db = drizzle(queryClient, { schema });
  return { queryClient, db };
}

function ensureClients(): { queryClient: Sql; db: Db } {
  if (!queryClientInstance || !dbInstance) {
    const built = buildClients();
    queryClientInstance = built.queryClient;
    dbInstance = built.db;
  }
  return { queryClient: queryClientInstance, db: dbInstance };
}

/**
 * Return the active Drizzle client. Materializes the underlying postgres-js
 * client on first call. Tests can override the result via
 * `__setDbForTesting()`.
 */
export function getDb(): Db {
  if (dbOverride) return dbOverride;
  return ensureClients().db;
}

/**
 * Lazy proxy that resolves to the real Drizzle client on each property
 * access. Lets existing call sites keep using `db.insert(...)` while the
 * underlying client is constructed on first use (or replaced in tests).
 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const target = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Db;

/**
 * Lightweight liveness probe for the database. Returns true on success and
 * false on any connection or query failure. Does not throw — `/ready` decides
 * what to do with the boolean.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    if (dbOverride) {
      // When a test override is installed, the underlying client is opaque to
      // us; assume the override is healthy for liveness purposes.
      return true;
    }
    const { queryClient } = ensureClients();
    await queryClient`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Test-only: install a Drizzle client to be returned by `getDb()` and `db`. */
export function __setDbForTesting(override: Db | undefined): void {
  dbOverride = override;
}
