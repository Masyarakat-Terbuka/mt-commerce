// Astro preset for the storefront. Layered on top of base so .astro files get
// the astro parser and .ts/.tsx files inside the storefront still see the
// shared TypeScript rules. React-hooks is included because the storefront
// renders React "islands" alongside its Astro components.

import globals from "globals";
import astro from "eslint-plugin-astro";
import reactHooks from "eslint-plugin-react-hooks";
import { baseConfig } from "./base.js";

/**
 * @type {import('eslint').Linter.Config[]}
 */
export const astroConfig = [
  ...baseConfig,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  ...astro.configs["flat/recommended"],
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
];

export default astroConfig;
