# ADR-0003: Drizzle over Prisma

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

The API needs a query layer between TypeScript and PostgreSQL. The choice shapes how migrations are authored, how query results are typed, how the application starts up, and how comfortable contributors feel reading database code.

The mainstream options in the TypeScript ecosystem are Prisma and Drizzle. Both are credible. Both are used in production by many teams. The decision is not about which is "better" in the abstract — it is about which fits a Bun-based, modular monolith handling money for Indonesian merchants on modest hardware.

A few constraints shape the choice:

- The runtime is Bun. Tooling that works well with Bun is preferred.
- Money is stored as `bigint` (see [ADR-0007](./0007-money-as-integers.md)). The query layer must handle `bigint` cleanly, both at the column type level and at serialization.
- Identifiers are ULID strings with typed prefixes (`prod_`, `ord_`, `cust_`). The query layer must let us define these as `text` columns with branded TypeScript types.
- Cold start matters. The API runs on small VPS deployments and in tests. A query layer that takes hundreds of milliseconds to initialize is felt every time a worker or a test suite starts.
- Migrations need to be readable. SQL is the lingua franca of operators; a migration that an operator cannot read is a migration that cannot be reviewed in confidence.

---

## Decision

mt-commerce uses **Drizzle ORM** as its query layer, with `drizzle-kit` for schema-driven migrations.

The schema is defined in TypeScript files under `apps/api/src/db/schema/`. Migrations are generated from schema changes by `drizzle-kit generate` and committed to `apps/api/drizzle/migrations/`. The runtime client is built on `postgres` (the `postgres-js` driver), wrapped by Drizzle, and exported as a singleton from `apps/api/src/db/client.ts`.

Prisma is not used.

---

## Consequences

### Positive

The schema lives in TypeScript and reads like the SQL it produces. A column declared as `bigint("price_cents", { mode: "bigint" })` returns a `bigint` in query results. There is no separate schema language to learn, no generated client to keep in sync with the source.

There is no separate query engine binary. Drizzle is a TypeScript library that builds SQL strings and hands them to the driver. Cold starts are fast — important for tests, important for cheap deployments, important for operators on small VPS plans.

Bun support is first-class. Drizzle works directly with `bun run` and `bun test`. The `drizzle-kit` CLI runs under Bun without workarounds.

The driver, `postgres` (postgres-js), is small, fast, and unopinionated. It handles connection pooling, prepared statements, and `bigint` correctly. It is well-suited to a single-region deployment behind a connection pooler in production.

Generated migrations are plain SQL files. An operator can read them, an auditor can review them, and a database administrator can run them outside the application if needed. The migration directory is the contract between the application and the database.

Query results are precisely typed against the schema. A query that joins `orders` to `order_items` returns a value whose shape the compiler knows. Refactors that rename a column or tighten a nullable break compilation, not production.

`bigint` mode is honored end-to-end. There is no silent coercion to `number` for monetary columns, which removes one entire class of bug at the storage boundary.

### Negative

The community is smaller than Prisma's. There are fewer Stack Overflow answers, fewer blog posts, and fewer tutorials. New contributors who have used Prisma will need a short onboarding to Drizzle's mental model.

The ecosystem of admin GUIs and visual tools around Drizzle is thinner. Prisma Studio is genuinely useful for inspecting data; Drizzle Studio exists but is younger. Operators who want a visual database browser may reach for `pgAdmin` or `psql` instead.

Generated types are inferred from the schema, not from a separate IDL. Some patterns that Prisma supports through generated client extensions (for example, soft-delete middleware that hides `deleted_at != null` rows automatically) require explicit helpers in Drizzle. We accept this; explicit is a feature when the application handles money.

Drizzle's API surface is moving faster than Prisma's. Minor versions occasionally adjust query builder ergonomics. Pinning the version and reading release notes is part of the maintenance cost.

There is no built-in migration history table at the same level of abstraction as Prisma's `_prisma_migrations`. Drizzle uses its own metadata table, which is straightforward but unfamiliar to operators coming from Prisma.

### Neutral

Drizzle does not generate a client file at the scale that Prisma does. There is no `node_modules/.prisma/client` to rebuild after every schema change. This is faster, but it also means the schema files themselves are the contract — there is no intermediate generated artifact to inspect when debugging.

---

## Alternatives considered

### Prisma

Prisma is the most-used ORM in the TypeScript ecosystem. It has excellent documentation, a polished schema language, a generated client with strong types, Prisma Studio for data inspection, and a large community.

It was rejected for this project because:

- Prisma's runtime depends on a separate query engine binary (historically Rust, with a TypeScript-native engine in progress). The binary adds startup cost, increases the deployment surface, and has been a source of friction on Bun and on Alpine-based images.
- The generated client is large and must be regenerated after every schema change. In a monorepo with workspaces, this creates ordering constraints in CI and local setup.
- The `.prisma` schema language is its own thing. Contributors learn it, then translate it back to SQL when reading migrations or debugging.
- Migration SQL is generated, but the schema source of truth is the `.prisma` file, not the SQL. Reviewing a migration means cross-referencing both.
- Bun support has historically lagged Node support. It has improved, but for a Bun-first project, choosing a tool that treats Bun as a first-class target is the lower-risk path.

These are real trade-offs, not deal-breakers in every project. For mt-commerce specifically, they outweigh the benefits.

### Kysely

Kysely is a typed query builder without an ORM layer. It has excellent types, no code generation, and works well with Bun. It was the closest competitor to Drizzle in this decision.

It was not chosen because schema definition and migration generation are not part of its scope. Pairing Kysely with a separate migration tool (such as `kysely-codegen` plus hand-written migrations) is workable but adds moving parts. Drizzle bundles schema, migrations, and querying in one cohesive tool, which is the right shape for the size of this project.

If Drizzle's direction ever conflicts with the project's needs, Kysely on top of `postgres-js` is a reasonable fallback. The application code that uses Drizzle is straightforward to port — both libraries operate close to SQL.

### Hand-written SQL with `postgres-js`

Writing SQL strings directly against the driver is the simplest possible setup. It is also the easiest to get wrong as the schema grows: typos in column names are not caught at compile time, and refactors require grep.

For a project that expects to define dozens of tables across a dozen modules, the type-checking gain from a query builder is worth the small abstraction cost. Rejected.

### TypeORM

TypeORM uses decorators on classes to define entities, then maps query results back to those classes. It pre-dates the typed-query-builder generation of tools.

It was rejected because the decorator-based mental model is a poor fit for a system that wants the schema to read like SQL and produce plain row objects. TypeORM's typing is also less precise than Drizzle's or Prisma's, and its migration generation has historically been less reliable.

---

## Implementation notes

### Schema location

```
apps/api/src/db/
├── client.ts           # Drizzle client, exported as `db`
└── schema/
    ├── index.ts        # Re-exports every table
    └── <module>.ts     # One file per module's tables
```

Each module owns its own schema file. The `index.ts` re-export keeps `drizzle.config.ts` pointed at a single entry.

### Driver

The runtime driver is `postgres` (postgres-js). It is configured with a small connection pool (`max: 10` by default, configurable via env) and a short idle timeout. Connection details come from `DATABASE_URL`.

```typescript
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const client = postgres(process.env.DATABASE_URL!, { max: 10 });
export const db = drizzle(client, { schema });
```

In tests, the same client is used against a disposable test database.

### Money columns

Monetary columns are `bigint` in `bigint` mode. The application reads and writes `bigint` values directly; serialization to JSON happens at the API boundary, where `bigint` becomes a string (per [ADR-0007](./0007-money-as-integers.md)).

```typescript
priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
```

### Identifiers

Identifiers are `text` columns. They are populated by the application from a typed ULID helper (`apps/api/src/lib/ulid.ts`) that produces values like `prod_01HZX...`. The database does not generate the IDs; the application does, so they are available before the row is inserted and can be used in logs and event payloads.

```typescript
id: text("id").primaryKey(),
```

### Migration workflow

Schema changes go through `bun run db:generate`, which invokes `drizzle-kit generate`. The resulting SQL file is reviewed and committed alongside the schema change. `bun run db:migrate` applies pending migrations in order.

Forward-fixing is preferred. If a migration introduces a bug, the next migration corrects it; we do not roll back in production. Migration files are append-only.

### What this ADR does not commit to

- The choice of connection pooler in production (PgBouncer, the application's own pool, a managed pooler) is a deployment concern, not a query-layer concern. It is decided per deployment.
- Read replicas, sharding, and other scale-out patterns are out of scope for v0.1 and will be revisited if and when they are needed.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — describes the data layer
- [ADR-0005](./0005-modular-monolith.md) — modular monolith; each module owns its tables
- [ADR-0007](./0007-money-as-integers.md) — money as `bigint`, which the query layer must handle correctly
