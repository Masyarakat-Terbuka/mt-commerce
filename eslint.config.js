/**
 * Root ESLint config — used by lint-staged at the workspace root and as a
 * fallback when ESLint is invoked outside any package. Each package keeps
 * its own `eslint.config.js` (which extends the same shared preset) so
 * `bun --filter '*' lint` continues to apply per-package overrides.
 */
import baseConfig from "@mt-commerce/eslint-config/base";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.astro/**",
      "**/build/**",
      "**/coverage/**",
      "**/drizzle/migrations/**",
      "apps/api/dist/**",
      "apps/admin/dist/**",
      "apps/storefront/dist/**",
    ],
  },
  ...baseConfig,
];
