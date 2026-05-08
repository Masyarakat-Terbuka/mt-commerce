// Admin extends the shared mt-commerce Prettier config with the Tailwind
// plugin so utility classes are sorted, and points at the admin's own
// stylesheet so Tailwind can resolve custom theme tokens.
import shared from "@mt-commerce/prettier-config" with { type: "json" };

/** @type {import('prettier').Config} */
export default {
  ...shared,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "src/index.css",
  tailwindFunctions: ["cn", "cva"],
};
