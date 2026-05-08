# syntax=docker/dockerfile:1.7
#
# mt-commerce Admin image (multi-stage).
#
# Stage 1 (build):   Bun runs Vite to produce a static `dist/`.
# Stage 2 (runtime): nginx:alpine-slim serves the static output.
#
# VITE_API_URL must be passed as a build arg because Vite inlines `VITE_*`
# at build time. In production it should be the public API URL, e.g.
# https://api.example.com.
#
# Built from the repo root:
#   docker build -f apps/admin/Dockerfile \
#     --build-arg VITE_API_URL=https://api.example.com \
#     -t mt-commerce-admin .

ARG VITE_API_URL=http://localhost:8000

# ---- Stage 1: build static assets ----
FROM oven/bun:1.3.7-alpine AS build
WORKDIR /app

# Workspace manifests for cacheable install.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/storefront/package.json ./apps/storefront/
COPY packages/core/package.json ./packages/core/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/plugins ./packages/plugins

RUN bun install --frozen-lockfile

# Source for the admin and the workspaces it depends on.
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/sdk ./packages/sdk
COPY apps/admin ./apps/admin

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /app/apps/admin
RUN bun run build

# ---- Stage 2: nginx static server ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Drop the default config; ours sets the SPA fallback.
USER root
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/admin/nginx.conf /etc/nginx/conf.d/admin.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
