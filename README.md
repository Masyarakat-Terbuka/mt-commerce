# mt-commerce

**Open-source commerce infrastructure for Indonesia.**

A modern commerce platform you can run, fork, and own. Built for Indonesian payments, shipping, and language from the start. Free under a permissive license.

By [Masyarakat Terbuka](https://github.com/masyarakat-terbuka).

> Status: early development. The shape is set; the code is being written in the open.

---

## What it is

mt-commerce is a headless commerce platform. The core is an API that handles everything a shop needs — products, orders, customers, payments, shipping, inventory — and a set of reference applications (admin and storefront) built on top of it.

You can run the whole thing on a single small server, replace any of the frontends with your own, or extend the engine through plugins. The API is the product; the apps are examples of what you can build with it.

There is no paid tier of the software. The code is the product.

---

## What it does

- **Products, variants, and inventory** with the structures real shops actually use
- **A storefront** that is fast on mobile and on slow connections
- **A checkout** with QRIS, virtual accounts, e-wallets, bank transfer, and cash on delivery
- **Shipping integration** with the couriers Indonesians use every day
- **An admin** in Bahasa Indonesia, built for shop owners, not engineers
- **WhatsApp order notifications** out of the box
- **A developer platform** with a documented HTTP API, webhooks, events, plugins, and an SDK
- **Local by default** — Rupiah, Bahasa Indonesia, Indonesian addresses down to the kelurahan level, and local tax handling without configuration

---

## Architecture

mt-commerce is intentionally headless. Three pieces, talking over HTTP:

```
   ┌───────────────┐   ┌──────────────────┐   ┌──────────────┐
   │  Admin app    │   │  Storefront      │   │  Your app    │
   │  (React)      │   │  (Astro)         │   │  (anything)  │
   └───────┬───────┘   └────────┬─────────┘   └──────┬───────┘
           │                    │                    │
           └────────────────────┼────────────────────┘
                                ▼
                        ┌───────────────┐
                        │   API (Hono)  │
                        └───────┬───────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          PostgreSQL          Redis          Plugins
```

The API is the engine. The admin and storefront are reference clients. Anyone can replace them, fork them, or build their own.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full picture.

---

## Tech stack

- **API:** [Hono](https://hono.dev/) on [Bun](https://bun.sh/), TypeScript end to end
- **Admin:** [Vite](https://vitejs.dev/) + [React](https://react.dev/)
- **Storefront:** [Astro](https://astro.build/) with React islands
- **Database:** [PostgreSQL](https://www.postgresql.org/)
- **Cache and queues:** [Redis](https://redis.io/)
- **Local development:** [Docker Compose](https://docs.docker.com/compose/)

The choices behind each are explained in [`docs/adr`](./docs/adr).

---

## Quick start

You will need [Docker](https://www.docker.com/) and [Bun](https://bun.sh/).

```bash
git clone https://github.com/masyarakat-terbuka/mt-commerce.git
cd mt-commerce

cp .env.example .env
docker compose up -d

# API at http://localhost:8000
# Admin at http://localhost:7000
# Storefront at http://localhost:3000
```

The default setup runs the API, database, cache, admin, and storefront together. Production deployment guides for common Indonesian and international hosts live in [`docs/deployment`](./docs/deployment).

---

## Documentation

- [Product](./PRODUCT.md) — what we are building and why
- [Architecture](./ARCHITECTURE.md) — how the system is shaped
- [Roadmap](./ROADMAP.md) — what is coming and in what order
- [Contributing](./CONTRIBUTING.md) — how to get involved
- [Security](./SECURITY.md) — how to report vulnerabilities responsibly

The full documentation, in Bahasa Indonesia and English, will live at `docs.masyarakat-terbuka.org` *(coming soon)*.

---

## For merchants

If you want to run a store on mt-commerce but do not want to set it up yourself, look for a partner agency or developer who can help. The project is open, so anyone can offer this service. We will list independent partners as the community grows.

---

## For developers

mt-commerce is meant to be extended. Themes, plugins, modules, and custom integrations are first-class. Read the [contributing guide](./CONTRIBUTING.md) and the [architecture overview](./ARCHITECTURE.md) to get oriented.

We welcome pull requests, issues, and discussions in either Bahasa Indonesia or English.

---

## Community

- **Discussions:** [GitHub Discussions](https://github.com/masyarakat-terbuka/mt-commerce/discussions)
- **Issues:** [GitHub Issues](https://github.com/masyarakat-terbuka/mt-commerce/issues)
- **Chat:** Discord *(coming soon)*

Please read the [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

---

## License

[MIT](./LICENSE). Use it for anything, including commercial work. Attribution is appreciated but not required by the license.

---

## About Masyarakat Terbuka

Masyarakat Terbuka — *the open community* — is a group of contributors building open infrastructure for Indonesia. mt-commerce is its first project.
