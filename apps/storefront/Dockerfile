# syntax=docker/dockerfile:1.7
#
# mt-commerce Storefront image (multi-stage).
#
# Stage 1 (build):   Bun runs `astro build` to produce a static `dist/`.
# Stage 2 (runtime): nginx-unprivileged serves the static output.
#
# Astro inlines `PUBLIC_*` env vars at build time. SITE is read by
# astro.config.mjs to set the canonical site URL, sitemap, and Open Graph
# metadata.
#
# Built from the repo root:
#   docker build -f apps/storefront/Dockerfile \
#     --build-arg PUBLIC_API_URL=https://api.example.com \
#     --build-arg SITE=https://example.com \
#     -t mt-commerce-storefront .

ARG PUBLIC_API_URL=http://localhost:8000
ARG SITE=http://localhost:4321

# ---- Stage 1: build static site ----
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

# Source for the storefront and the workspaces it depends on.
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/sdk ./packages/sdk
COPY apps/storefront ./apps/storefront

ARG PUBLIC_API_URL
ARG SITE
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
ENV SITE=${SITE}

WORKDIR /app/apps/storefront
RUN bun run build

# ---- Stage 2: nginx static server ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

USER root
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/storefront/nginx.conf /etc/nginx/conf.d/storefront.conf
COPY --from=build /app/apps/storefront/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
