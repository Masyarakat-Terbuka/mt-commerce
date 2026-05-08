// React preset for mt-commerce frontends (admin, and any future Vite/React app).
// Adds react-hooks and react-refresh on top of the shared base.

import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { baseConfig } from "./base.js";

/**
 * @type {import('eslint').Linter.Config[]}
 */
export const reactConfig = [
  ...baseConfig,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
];

export default reactConfig;
