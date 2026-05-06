# @mt-commerce/api

The Hono backend for mt-commerce. See [`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the system shape and [`docs/v0.1-checklist.md`](../../docs/v0.1-checklist.md) for the in-flight work.

## Quick start

```bash
# from the repo root
docker compose up -d                       # postgres + redis
cp apps/api/.env.example apps/api/.env
bun install
bun --filter @mt-commerce/api db:migrate
bun --filter @mt-commerce/api dev
```

The API listens on `http://localhost:8000` by default. Health endpoints:

- `GET /health` — process is up
- `GET /ready` — Postgres reachable
- `POST /v1/ping` — end-to-end smoke test (writes a row, reads it back)
- `GET /openapi.json` — OpenAPI document
- `GET /docs` — Swagger UI (development only)

## Scripts

| Script        | What it does                                |
| ------------- | ------------------------------------------- |
| `dev`         | `bun run --watch src/server.ts`             |
| `build`       | `tsc -p tsconfig.build.json`                |
| `typecheck`   | `tsc --noEmit`                              |
| `lint`        | `eslint .`                                  |
| `test`        | `vitest run`                                |
| `db:generate` | `drizzle-kit generate` from schema changes  |
| `db:migrate`  | apply pending migrations                    |
