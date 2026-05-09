// Docs site extends the shared mt-commerce Prettier config with the Astro
// plugin so `.astro` components (e.g. ScalarApiReference) format cleanly.
// Mirrors the storefront's pattern; we skip the Tailwind plugin here since
// the docs site uses Starlight's built-in styles, not Tailwind.
import shared from "@mt-commerce/prettier-config" with { type: "json" };

/** @type {import('prettier').Config} */
export default {
  ...shared,
  plugins: ["prettier-plugin-astro"],
  overrides: [
    {
      files: "*.astro",
      options: { parser: "astro" },
    },
  ],
};
