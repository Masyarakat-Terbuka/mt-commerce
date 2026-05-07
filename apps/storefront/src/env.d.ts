/// <reference path="../.astro/types.d.ts" />

/**
 * Public env vars exposed to both the static build and client islands.
 * Astro inlines anything prefixed `PUBLIC_` at build time, which is what
 * the SDK calls in React islands need to reach the API from the browser.
 */
interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
