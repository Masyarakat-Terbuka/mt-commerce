// Storefront extends the shared mt-commerce Prettier config with the Astro
// and Tailwind plugins. The Astro plugin formats `.astro` files; the
// Tailwind plugin sorts utility classes everywhere they appear.
import shared from "@mt-commerce/prettier-config" with { type: "json" };

/** @type {import('prettier').Config} */
export default {
  ...shared,
  plugins: ["prettier-plugin-astro", "prettier-plugin-tailwindcss"],
  overrides: [
    {
      files: "*.astro",
      options: { parser: "astro" },
    },
  ],
};
