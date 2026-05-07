-- Product images.
--
-- Adds two nullable text columns to `products` so the storefront can render
-- a hero image and accessible alt text per product.
--
-- The columns are nullable because:
--   * Existing data (drafts, partially imported catalogs) may not yet have
--     an image. Re-running this migration on a populated database must not
--     break those rows.
--   * The image-upload pipeline (separate v0.1 item) will write here from
--     the admin; until then, seeds and external URLs populate it.
--
-- A future `product_images` table for multi-image galleries will read these
-- columns at migration time, copy them into the gallery, and either keep
-- the columns as a denormalized "primary image" cache or drop them. Both
-- paths stay open while the storage shape is a single nullable URL.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_alt" text;
