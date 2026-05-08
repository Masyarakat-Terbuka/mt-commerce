/**
 * Example `mt-commerce.config.ts`. Copy this file to `mt-commerce.config.ts`
 * (without the `.example`) to enable plugins.
 *
 * The plugin loader reads this file at api boot from one of:
 *
 *   1. The path in `MT_COMMERCE_CONFIG` (overrides everything)
 *   2. `apps/api/mt-commerce.config.ts` (canonical location)
 *   3. `<workspace-root>/mt-commerce.config.ts` (fallback)
 *
 * If no file exists, the api boots with no plugins and an info-level log
 * line. Plugins are an opt-in extension surface — the platform works
 * standalone.
 */
import { defineConfig } from "@mt-commerce/core/plugin";
import examplePlugin from "@mt-commerce/plugin-example";

export default defineConfig({
  plugins: [
    // The bundled example plugin — registers an "example" notification
    // channel and an `order.placed` listener. Useful as a smoke test.
    examplePlugin({ verbose: true }),
    // Add real plugins below, e.g.:
    //   midtransPlugin({ apiKey: process.env.MIDTRANS_KEY ?? "" }),
    //   biteshipPlugin({ apiKey: process.env.BITESHIP_KEY ?? "" }),
  ],
});
