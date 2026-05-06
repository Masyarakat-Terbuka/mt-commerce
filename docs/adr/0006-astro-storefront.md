# ADR-0006: Astro for the storefront

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

[ADR-0001](./0001-headless-architecture.md) committed mt-commerce to a headless architecture: the API is a standalone service, and frontends consume it as clients. This ADR records how the reference storefront is built.

A storefront has a specific shape. The pages most visitors see — the home page, category pages, product pages, content pages — are content-heavy, mostly static, and SEO-critical. A handful of pages are deeply interactive: cart, search, checkout, account. The framework choice has to serve both ends well.

The audience matters. mt-commerce is built for Indonesia. Most shoppers browse on mobile, often on networks that are slower and more variable than the connections frameworks are typically benchmarked against. Time to first paint, total JavaScript shipped, and behavior on poor connections are not abstract concerns; they are the difference between a sale and an abandoned tab.

A few framework patterns sit on the table:

**Component-first frameworks** (Next.js, Nuxt, SvelteKit, Remix / React Router 7) — the page is a component tree, hydration is the default, and the server-rendered HTML exists primarily as a launch pad for client-side React. Optimizations exist (RSC, partial hydration, islands) but they are added on top of a hydration-first baseline.

**Content-first frameworks with islands** (Astro) — the page is server-rendered HTML by default and ships zero JavaScript. Interactive components are explicitly opted in as islands and carry only their own JavaScript. Interactivity is a deliberate addition rather than a default.

**Single-page applications** (Vite + React, etc.) — the server returns an HTML shell, and the client renders everything. Strong for behind-login interactive apps; weak for content and SEO.

For a storefront where most pages are content and a few pages are interactive, the content-first model fits the shape of the work better than the others.

---

## Decision

The reference storefront is built with **Astro**, with React for interactive islands through `@astrojs/react`.

The stack:

- Astro for the framework, file-based routing, and SSR
- React for interactive islands (cart, search, checkout, account)
- Tailwind CSS for styling
- The mt-commerce SDK as the typed API client

Content pages — product detail, category, home, static pages — are server-rendered HTML and ship no JavaScript by default. Interactive parts are mounted as islands with explicit hydration directives (`client:load`, `client:visible`, `client:idle`).

---

## Consequences

### Positive

The default JavaScript payload for content pages is essentially zero. A product page that does not need client-side interactivity above the cart button ships only the cart island. Time to first paint, time to interactive, and Core Web Vitals all benefit directly. On the slow mobile connections most Indonesian shoppers use, this is the difference that matters.

SEO is straightforward. Astro renders complete HTML on the server. Search engines, link previews, and social-card scrapers see real content without executing JavaScript. There is no SSR-to-SPA-handoff edge case to worry about.

The interactive parts are still rich React. Cart, search, checkout, and account pages are React components mounted as islands. Their developer experience is the same as any other React app — components, hooks, state, the SDK — but they live alongside server-rendered pages instead of taking over the entire frontend.

Content tooling is built in. File-based routing for `.astro` and `.mdx` pages, image optimization through `<Image />`, content collections with typed frontmatter — these are first-class features rather than plugins. Product descriptions, blog posts, help pages, and policy pages compose with the rest of the site without extra integrations.

Astro and React share a Vite toolchain. The build is fast, HMR is fast, and the storefront integrates with the same packages (`@mt-commerce/sdk`, `@mt-commerce/core`) that the rest of the monorepo uses.

The architecture matches the principle in [`PRODUCT.md`](../../PRODUCT.md): the storefront is fast for shoppers, especially on the connections most Indonesians actually have.

### Negative

Astro is less common in commerce than Next.js. There are fewer commerce-specific examples, fewer pre-built themes, and fewer Stack Overflow answers indexed against `astro + commerce` than against `next + commerce`. The ecosystem is growing but still smaller.

The boundary between server-rendered Astro pages and React islands needs deliberate design. Props passed into an island are serialized, so non-serializable values (functions, class instances, complex SDK objects) cannot cross the boundary directly. State that needs to be shared between islands lives in a client-side store (for example, a cart store) rather than React context spanning the page.

Some patterns that come for free in Next.js — middleware composing across the app, layout state shared across routes, server actions called from client components — translate into different shapes in Astro. They are reachable, but the path is different.

The community is smaller than React-only frameworks. For the maintainers, this means more first-principles work and fewer ready-made answers. For agencies adopting the storefront, it means a slightly higher learning curve when their team's experience is mostly Next.js.

The Astro release cadence is faster than some teams are used to. Tracking it requires occasional version bumps and migration effort.

---

## Alternatives considered

### Next.js

Next.js is the default reflex for a JavaScript storefront. It has a large ecosystem, well-known patterns, and many existing commerce examples. It was considered seriously and rejected for the reference storefront.

The deciding factor is the JavaScript budget on content pages. Even with the App Router, Server Components, and aggressive code-splitting, a Next.js page hydrates a React component tree by default. Keeping that tree small on a content-heavy storefront takes ongoing discipline against the framework's grain. Astro's grain points the other way: zero JavaScript by default, opt in for interactivity. For shoppers on slow mobile connections, this is a meaningful difference at the level of bytes shipped on every page load.

Next.js remains a defensible choice for an alternative storefront — and nothing in the headless architecture prevents one. The reference storefront optimizes for a different priority.

### SvelteKit

SvelteKit is excellent technically: small bundles, ergonomic syntax, fast SSR. It was rejected for two reasons specific to this project:

- The team's React experience comes from the admin. Adding Svelte introduces a second component model and a second hiring requirement, which is a real cost for a small team.
- The Svelte hiring pool in Indonesia is meaningfully smaller than the React pool. Agencies adopting the storefront would face a steeper staffing problem.

The technical merits of SvelteKit are not in question. The cost of forking the team's framework expertise was the deciding factor.

### Remix / React Router 7

Remix (now merged into React Router 7) emphasizes web fundamentals, nested routing, and progressive enhancement. It is a strong choice and improving steadily.

It was rejected for the reference storefront because, like Next.js, its baseline still hydrates the page as a React component tree. The JavaScript budget on a content page is harder to keep near zero than in Astro. The trade-off is real, and Remix is a reasonable alternative for someone who wants those patterns. The reference storefront optimizes the other way.

### All-React single-page application

A Vite + React SPA was rejected outright. SPAs are a poor fit for a storefront:

- The first byte returns an empty HTML shell. Search engines and link previews see nothing useful without rendering.
- The first paint waits for the JavaScript bundle to download, parse, execute, and fetch data. On slow connections this is painful.
- Caching is harder; cache-friendly content lives behind a JavaScript boot.

The admin is an SPA because its priorities are different — interactive, behind login, no SEO concern. The storefront's priorities are the opposite.

### Nuxt

Nuxt is a reasonable framework. It was rejected because it commits the project to Vue, which is not the team's stack and not consistent with the React choice for the admin and for islands. Maintaining two component frameworks across the platform is a cost without a corresponding benefit here.

### Hand-rolled SSR with React

A hand-rolled server-rendered React setup (Express or Hono plus React's SSR APIs) was considered briefly. It was rejected because it would mean reinventing routing, data loading, asset pipelines, image optimization, and content collections — all things an established framework provides. The maintenance cost would not be repaid.

---

## A note on consistency with the admin

The admin uses Vite + React ([ADR-0001](./0001-headless-architecture.md), [ADR-0009](./0009-shadcn-preset.md)). The storefront uses Astro with React islands. They are different.

This is intentional and consistent with the headless architecture. The admin and the storefront have different priorities:

- The admin is interactive, behind login, and has no SEO concern. An SPA serves it well.
- The storefront is content-heavy, public, SEO-critical, and performance-sensitive on slow connections. A content-first framework with islands serves it well.

Forcing both into the same framework would compromise one of them. Each app uses the right tool for its job, and both consume the same API the same way. That is one of the reasons the system is headless in the first place.

---

## Implementation notes

The following commitments follow directly from this decision:

- The storefront lives at `apps/storefront/`.
- Pages are `.astro` files for server-rendered routes; interactive components are React (`.tsx`) mounted as islands with explicit `client:*` directives.
- The SDK (`@mt-commerce/sdk`) is the only way the storefront talks to the API. Direct `fetch` calls to the API are not used.
- Tailwind is configured through Astro's Vite integration. Tailwind v4 matches the admin's version where practical.
- Bahasa Indonesia is the default locale; English is available. Strings live in translation files alongside the pages that use them.
- Image optimization uses Astro's built-in `<Image />` component for product images and content images.
- Static generation is the default for content pages where the data does not change per request. SSR is used for pages that depend on session or per-request state (cart, checkout). The chosen mode per page is documented near the page itself.
- Whether the storefront reuses the admin's shadcn/ui setup ([ADR-0009](./0009-shadcn-preset.md)) is left open — Astro with islands has different needs, and that decision will land separately if it becomes worth recording.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the storefront's place in the system
- [ADR-0001](./0001-headless-architecture.md) — the headless decision that allows different frameworks per app
- [ADR-0009](./0009-shadcn-preset.md) — the admin's design system, intentionally a separate decision
- [`PRODUCT.md`](../../PRODUCT.md) — the principles around performance for Indonesian shoppers
