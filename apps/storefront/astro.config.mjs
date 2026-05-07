// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";

// `site` is required for canonical URLs, the sitemap, and absolute URLs in
// JSON-LD / Open Graph metadata. The placeholder below is a sentinel:
// production builds should override it via the `SITE` env var (set in CI or
// the deploy environment) so a deploy never publishes the example.com host.
// We accept the env var here rather than reading inside templates because
// `Astro.site` is the canonical source of truth across the app.
const SITE_URL = process.env.SITE ?? "https://mt-commerce.example";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  /*
   * Integrations
   *
   * - `react()` mounts React for interactive islands (cart, checkout, etc.).
   * - `mdx()` enables `.mdx` files for content collections. Static content
   *   pages (help topics, legal drafts) live as MDX so authors can compose
   *   prose with the small set of components we expose, without touching
   *   page-level routing for every new article.
   * - `sitemap()` walks every emitted page at build time and writes
   *   `sitemap-index.xml` + per-locale `sitemap-N.xml` into `dist/`. The
   *   `i18n` config makes it emit `<xhtml:link rel="alternate" hreflang>`
   *   entries for the id/en pair on every URL — Google's recommendation
   *   for multi-locale sites, mirrored in `BaseLayout`'s alternate links.
   *   See: https://docs.astro.build/en/guides/integrations-guide/sitemap/
   */
  integrations: [
    react(),
    mdx(),
    sitemap({
      i18n: {
        defaultLocale: "id",
        locales: {
          id: "id-ID",
          en: "en-US",
        },
      },
    }),
  ],
  vite: {
    // Tailwind v4's Vite plugin and Astro's bundled Vite resolve to slightly
    // different `Plugin` types in this monorepo (Vite 7 vs Vite 6). The plugin
    // is functionally compatible — the structural mismatch is on the type side
    // only, so we hand it across the boundary as `any`. Re-evaluate after the
    // next Astro major bumps its bundled Vite.
    plugins: [/** @type {any} */ (tailwindcss())],
  },
  i18n: {
    defaultLocale: "id",
    locales: ["id", "en"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  output: "static",
});
