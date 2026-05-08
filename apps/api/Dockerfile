# syntax=docker/dockerfile:1.7
#
# mt-commerce API image (multi-stage).
#
# Stage 1 (deps):    install workspace dependencies with bun.
# Stage 2 (runtime): a slim image that copies node_modules + the source
#                    Bun runs directly. The API has no separate bundle
#                    step in production (Bun loads TS at runtime), so the
#                    runtime stage carries `src/`, `drizzle/migrations/`,
#                    and `package.json` only.
#
# Built from the repo root so it can pull in workspace packages:
#   docker build -f apps/api/Dockerfile -t mt-commerce-api .

# ---- Stage 1: install dependencies ----
FROM oven/bun:1.3.7-alpine AS deps
WORKDIR /app

# Copy workspace manifests first so the install layer is cacheable.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/storefront/package.json ./apps/storefront/
COPY packages/core/package.json ./packages/core/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/plugins ./packages/plugins

# `--frozen-lockfile` mirrors `npm ci` semantics: fail on lockfile drift.
RUN bun install --frozen-lockfile

# ---- Stage 2: runtime ----
FROM oven/bun:1.3.7-alpine AS runtime
WORKDIR /app

# wget is used by the HEALTHCHECK below. Alpine does not ship one by default.
RUN apk add --no-cache wget tini \
    && addgroup -S mt && adduser -S mt -G mt

# Bring node_modules + the workspace symlinks from the deps stage. Bun
# hoists everything to the workspace root, so there's nothing to copy
# from `apps/api/node_modules` — the api resolves through the root.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages

# Source + migrations + workspace manifests the runtime needs.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/src ./apps/api/src
COPY tsconfig.base.json ./

# Optional plugin config — copied if the operator supplied one at build time.
# The wildcard form does not fail when the file is absent.
COPY apps/api/mt-commerce.config* ./apps/api/

RUN chown -R mt:mt /app
USER mt

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# tini reaps zombies and forwards SIGTERM cleanly to bun.
ENTRYPOINT ["/sbin/tini", "--"]

# Healthcheck hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/health > /dev/null || exit 1

# Run migrations before the server starts. The migrate script is forward-only
# and idempotent (drizzle-kit checks the journal), so re-running it on every
# deploy is safe.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
