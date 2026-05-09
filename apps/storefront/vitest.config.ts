import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    css: false,
    // Lib tests stay on `node` (no DOM, faster); island tests opt into
    // `jsdom` via a `// @vitest-environment jsdom` comment at the top of
    // each file. Avoids the deprecated `environmentMatchGlobs` API.
    environment: "node",
  },
});
