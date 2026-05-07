/**
 * Content collections for static content pages.
 *
 * Why content collections (vs. raw `.astro` files per topic): the help and
 * legal pages are prose-heavy with light frontmatter (title, summary, last
 * updated). Authors should be able to add a new help topic by dropping a
 * single `.mdx` file in the right folder — no route file, no list-page
 * edit. Astro's content collections give us typed frontmatter + a glob
 * loader for free.
 *
 * Locale strategy — folder per locale.
 *   help/id/{shipping,returns,payment,faq}.mdx
 *   help/en/{shipping,returns,payment,faq}.mdx
 *   legal/id/{privacy,terms}.mdx
 *   legal/en/{privacy,terms}.mdx
 *
 * The folder mirrors the route structure (`/help/...` for id, `/en/help/...`
 * for en) and lets us filter entries by `entry.id.startsWith("id/")` in
 * `getCollection()`. We considered a `locale` field on each entry, but the
 * folder approach colocates language pairs visually and keeps the schema
 * smaller. Drift between id/en (a missing translation) shows up as a
 * structural diff in `git status`, which is what we want.
 *
 * About — this is intentionally a flat `.astro` page rather than a
 * collection entry. There is exactly one about page per locale, and the
 * collection ceremony would not pay for itself at n=1.
 */
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const help = defineCollection({
  // The `glob` loader picks up `.mdx` (and `.md`) files under the directory
  // and exposes them via `getCollection("help")`. The `id` field on each
  // entry is the file path relative to `base`, e.g. "id/shipping" — exactly
  // what we want for locale filtering and routing.
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/help" }),
  schema: z.object({
    title: z.string(),
    /** One-line summary used in the help index card. */
    summary: z.string(),
    /**
     * Optional ordering hint for the help index. Lower numbers come first.
     * Topics without `order` fall to the end and are sorted alphabetically.
     */
    order: z.number().int().nonnegative().optional(),
  }),
});

const legal = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/legal" }),
  schema: z.object({
    title: z.string(),
    /**
     * ISO-8601 date string (YYYY-MM-DD) of the last meaningful change.
     * Surfaced in the page header so visitors know how current the draft is.
     * Stored as a string rather than `z.date()` so the value round-trips
     * predictably from frontmatter without timezone surprises.
     */
    lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export const collections = { help, legal };
