// Base ESLint preset for mt-commerce: TypeScript + JS recommended.
// Used directly by packages and by the api app. Other presets extend this.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * @type {import('eslint').Linter.Config[]}
 */
export const baseConfig = [
  {
    ignores: [
      "dist",
      "build",
      "drizzle",
      "node_modules",
      "coverage",
      ".astro",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
];

export default baseConfig;
