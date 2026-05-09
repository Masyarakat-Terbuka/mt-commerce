-- Postgres full-text search for the catalog.
--
-- Adds a generated `tsvector` column on `products` that concatenates the
-- title (weight A) and description (weight B) for both supported locales,
-- and a GIN index over it for `@@` lookups.
--
-- The `simple` config is intentional: the column mixes Indonesian and
-- English in one vector, and neither locale's stemmer can be applied
-- without mangling the other. `simple` lower-cases tokens but does no
-- stemming or stop-word removal — appropriate for short product copy
-- where every meaningful word matters.
--
-- Replaces the previous JSONB `ILIKE` predicate in
-- `apps/api/src/modules/catalog/repository.ts` (see ADR-0010 "Negative
-- consequences" for the motivation).
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("translations"->'id'->>'title', '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("translations"->'en'->>'title', '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("translations"->'id'->>'description', '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("translations"->'en'->>'description', '')), 'B')
  ) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_search_vector_idx" ON "products" USING GIN ("search_vector");
