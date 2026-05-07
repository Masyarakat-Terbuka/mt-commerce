-- Product content translations.
--
-- Per ADR-0010, translatable catalog rows store their localized strings in
-- a single `translations jsonb` column. The shape is:
--
--   { "id": { "title": "...", "description": "..." },
--     "en": { "title": "...", "description": "..." } }
--
-- The fields under each locale key match the row's translatable set:
-- `title` + `description` for products, `title` for variants, `name` for
-- categories.
--
-- This migration does three things in sequence:
--
--   1. Adds `translations jsonb NOT NULL DEFAULT '{}'::jsonb` to each
--      translatable table.
--   2. Backfills the JSONB column from the existing single-string columns.
--      Every existing row's user-visible text lands under the default
--      locale slot (`id`). The backfill is lossless.
--   3. Drops the redundant single-string columns now that the JSONB column
--      is the source of truth.
--
-- No GIN index is added in v0.1. The catalog does not filter by translated
-- content today; admin/storefront list-search uses ILIKE on the resolved
-- locale, and the resolver runs in application code. A generated `tsvector`
-- (or a partial GIN over `translations`) is recorded as a follow-up if and
-- when full-text search needs it.

-- ---------------------------------------------------------------------------
-- 1. Add translations columns (NOT NULL with empty-object default so the
--    backfill below has a typed slot to write into).
-- ---------------------------------------------------------------------------
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "translations" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "translations" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "translations" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Backfill from existing columns. Each existing string lands under the
--    default-locale slot. NULL `description` becomes a missing field in the
--    JSONB rather than `null` — the resolver treats both as "absent" and
--    falls through.
--
--    The product_variants backfill skips variants whose `title` is NULL
--    (default/single-variant products carry no localizable string), so
--    those rows keep an empty `'{}'::jsonb`.
-- ---------------------------------------------------------------------------
UPDATE "products"
SET "translations" = jsonb_strip_nulls(
  jsonb_build_object(
    'id', jsonb_strip_nulls(
      jsonb_build_object(
        'title', "title",
        'description', "description"
      )
    )
  )
)
WHERE "translations" = '{}'::jsonb;
--> statement-breakpoint

UPDATE "product_variants"
SET "translations" = CASE
  WHEN "title" IS NULL THEN '{}'::jsonb
  ELSE jsonb_build_object('id', jsonb_build_object('title', "title"))
END
WHERE "translations" = '{}'::jsonb;
--> statement-breakpoint

UPDATE "categories"
SET "translations" = jsonb_build_object(
  'id', jsonb_build_object('name', "name")
)
WHERE "translations" = '{}'::jsonb;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Drop the now-redundant single-string columns. The JSONB column is the
--    source of truth; the application resolver flattens it back to the
--    requested locale at read time.
-- ---------------------------------------------------------------------------
ALTER TABLE "products" DROP COLUMN IF EXISTS "title";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "description";
--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN IF EXISTS "title";
--> statement-breakpoint
ALTER TABLE "categories" DROP COLUMN IF EXISTS "name";
