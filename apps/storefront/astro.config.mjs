// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
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
