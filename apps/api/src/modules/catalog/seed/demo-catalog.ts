/**
 * Demo catalog seed.
 *
 * Six realistic Indonesian products covering coffee, batik, handicrafts,
 * and food, with categories and per-variant inventory. Built so that a
 * developer running `bun run db:seed` immediately sees data in the
 * storefront and admin without having to handcraft a product through
 * the API.
 *
 * ----------------------------------------------------------------------
 * Demo images
 *
 * Each product carries a single `imageUrl` sourced from Unsplash under
 * the Unsplash License (https://unsplash.com/license). Photographers
 * are credited per-product in the `imageAttribution` field so the
 * source remains discoverable as the seed evolves. The storefront
 * does not surface attribution today; the field is intended for the
 * upcoming admin "media library" view and for honest credit when a
 * theme adopts the demo data.
 *
 * URLs go through the `images.unsplash.com` CDN with a fixed `w=1200`
 * + `q=80` so the storefront receives a predictable size regardless
 * of the photographer's original. Alt text is in Bahasa Indonesia
 * to match the catalog's primary locale.
 * ----------------------------------------------------------------------
 *
 * Money rules (per ADR-0007):
 *   - All prices are IDR, stored as `bigint` whole rupiah on
 *     `product_variants.price_amount`.
 *   - The product `default_currency` is "IDR"; every variant's
 *     `price_currency` matches — the service layer enforces the same
 *     rule in production.
 *
 * Identifier rules:
 *   - Product, variant, category, and inventory ids are application-
 *     generated ULIDs with the prefixes used by the catalog module
 *     (`prod_`, `var_`, `cat_`, `inv_`). New ids are generated on every
 *     seed call so a wiped DB gets fresh ids; idempotency is enforced
 *     against the *natural keys* (slug for products/categories, sku for
 *     variants), not the surrogate ulids.
 *
 * Idempotency strategy:
 *   - Categories: ON CONFLICT (slug) DO NOTHING.
 *   - Products: ON CONFLICT (slug) DO NOTHING. After the insert, we
 *     SELECT the row back by slug to obtain the canonical id (which is
 *     the existing id on a re-run, our freshly-generated id on a first
 *     run).
 *   - Variants: ON CONFLICT (sku) DO NOTHING.
 *   - Inventory levels: keyed by variant_id+location_id (NULL location
 *     for v0.1). We check existence before inserting because the unique
 *     constraint on that pair lives in two partial indexes (see
 *     `db/schema/inventory_levels.ts`) and Drizzle's `.onConflictDoNothing`
 *     does not let us name a partial-index constraint by `target` —
 *     the upstream pattern for this table is "look first, insert if
 *     absent", and we follow it here.
 *   - product_categories junctions: ON CONFLICT (composite PK) DO NOTHING.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { id } from "@mt-commerce/core/ulid";
import {
  categories,
  inventoryLevels,
  productCategories,
  productVariants,
  products,
  type NewCategoryRow,
  type NewInventoryLevelRow,
  type NewProductCategoryRow,
  type NewProductRow,
  type NewProductVariantRow,
} from "../../../db/schema/index.js";
import type * as schema from "../../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface DemoCatalogSeedSummary {
  categories: number;
  products: number;
  variants: number;
  inventoryLevels: number;
  productCategories: number;
  inserted: {
    categories: number;
    products: number;
    variants: number;
    inventoryLevels: number;
    productCategories: number;
  };
}

// ---------------------------------------------------------------------------
// Static seed shape — slugs and SKUs are the natural keys we conflict on.
// ---------------------------------------------------------------------------

const CURRENCY = "IDR";

interface SeedCategory {
  slug: string;
  name: string;
}

const CATEGORIES: readonly SeedCategory[] = Object.freeze([
  { slug: "kopi", name: "Kopi" },
  { slug: "batik", name: "Batik" },
  { slug: "kerajinan", name: "Kerajinan" },
  { slug: "kuliner", name: "Kuliner" },
  { slug: "fashion", name: "Fashion" },
]);

interface SeedVariant {
  sku: string;
  /** Null for default/single-variant products. */
  title: string | null;
  /** Whole-rupiah price as a bigint per ADR-0007. */
  priceAmount: bigint;
}

interface SeedProduct {
  slug: string;
  title: string;
  description: string;
  /** Unsplash CDN URL or other long-lived image URL. */
  imageUrl: string;
  /** Bahasa Indonesia alt text describing the photo. */
  imageAlt: string;
  /**
   * Free-form credit. Not surfaced in the storefront yet but kept with
   * the data so the source of every image stays traceable.
   */
  imageAttribution: string;
  /** Slugs into `CATEGORIES` — resolved to ids during seeding. */
  categorySlugs: readonly string[];
  variants: readonly SeedVariant[];
}

const PRODUCTS: readonly SeedProduct[] = Object.freeze([
  {
    slug: "kopi-arabika-gayo-200g",
    title: "Kopi Arabika Gayo 200g",
    description:
      "Single-origin arabica from the Gayo highlands of Aceh. Bright acidity with notes of cocoa and citrus. Roasted to order.",
    // Close-up of dark-roast coffee beans — photographer Mike Kenneally.
    imageUrl:
      "https://images.unsplash.com/photo-1442550528053-c431ecb55509?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Biji kopi arabika sangrai medium tampak dekat",
    imageAttribution: "Mike Kenneally on Unsplash",
    categorySlugs: ["kopi"],
    variants: [
      { sku: "KOPI-GAYO-200", title: null, priceAmount: 95_000n },
    ],
  },
  {
    slug: "kopi-kintamani-bali-200g",
    title: "Kopi Kintamani Bali 200g",
    description:
      "Washed arabica from the Kintamani highlands. Citrus-forward cup with a clean finish. Choose whole bean for maximum freshness.",
    // Roasted coffee beans, top-down — photographer Mike Kenneally.
    imageUrl:
      "https://images.unsplash.com/photo-1497935586351-b67a49e012bf?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Biji kopi sangrai dari sudut atas",
    imageAttribution: "Mike Kenneally on Unsplash",
    categorySlugs: ["kopi"],
    variants: [
      { sku: "KOPI-KINTA-200-WB", title: "Whole bean", priceAmount: 110_000n },
      { sku: "KOPI-KINTA-200-GR", title: "Ground", priceAmount: 110_000n },
    ],
  },
  {
    slug: "batik-tulis-pekalongan-l",
    title: "Batik Tulis Pekalongan",
    description:
      "Hand-drawn batik tulis from Pekalongan, north-coast pattern. Each piece is one-of-a-kind. 100% cotton, soft drape.",
    // Folded textile / patterned fabric stack — photographer Annie Spratt.
    imageUrl:
      "https://images.unsplash.com/photo-1528459801416-a9241982d05a?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Tumpukan kain bermotif terlipat",
    imageAttribution: "Annie Spratt on Unsplash",
    categorySlugs: ["batik", "fashion"],
    variants: [
      { sku: "BATIK-PEKA-M", title: "Size M", priceAmount: 850_000n },
      { sku: "BATIK-PEKA-L", title: "Size L", priceAmount: 850_000n },
      { sku: "BATIK-PEKA-XL", title: "Size XL", priceAmount: 850_000n },
    ],
  },
  {
    slug: "keranjang-rotan-besar",
    title: "Keranjang Rotan Besar",
    description:
      "Large rattan basket woven by artisans in Cirebon. Sturdy, lightweight, perfect for laundry or storage.",
    // Woven rattan basket — photographer Sarah Brown.
    imageUrl:
      "https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Keranjang anyaman rotan berukuran besar",
    imageAttribution: "Sarah Brown on Unsplash",
    categorySlugs: ["kerajinan"],
    variants: [
      { sku: "ROTAN-BSR-001", title: null, priceAmount: 175_000n },
    ],
  },
  {
    slug: "gerabah-kasongan-set",
    title: "Gerabah Kasongan Set",
    description:
      "Three-piece earthenware set from Kasongan, Yogyakarta. Hand-thrown and fired in a traditional kiln.",
    // Hand-thrown earthenware vessels — photographer Earl Wilcox.
    imageUrl:
      "https://images.unsplash.com/photo-1493106641515-6b5631de4bb9?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Set gerabah tanah liat hasil pembakaran tradisional Kasongan",
    imageAttribution: "Earl Wilcox on Unsplash",
    categorySlugs: ["kerajinan"],
    variants: [
      { sku: "GERAB-KASO-SET3", title: null, priceAmount: 220_000n },
    ],
  },
  {
    slug: "keripik-tempe-malang-250g",
    title: "Keripik Tempe Malang 250g",
    description:
      "Crispy tempeh chips from Malang. Two flavors: original (savory) and pedas (spicy). 250g resealable pouch.",
    // Indonesian-style fried chips — photographer Louis Hansel.
    imageUrl:
      "https://images.unsplash.com/photo-1604908554049-1f9d9b4c3b81?w=1200&q=80&auto=format&fit=crop",
    imageAlt: "Camilan keripik renyah di atas piring",
    imageAttribution: "Louis Hansel on Unsplash",
    categorySlugs: ["kuliner"],
    variants: [
      { sku: "KRIP-TEMPE-MLG-ORI", title: "Original", priceAmount: 28_000n },
      { sku: "KRIP-TEMPE-MLG-PED", title: "Pedas", priceAmount: 28_000n },
    ],
  },
]);

const INITIAL_AVAILABLE = 100;
const INITIAL_RESERVED = 0;

// ---------------------------------------------------------------------------
// Seed runner
// ---------------------------------------------------------------------------

/**
 * Insert demo catalog rows idempotently. Returns the static shape (always
 * equal to the dataset size) and the dynamic per-table inserted counts
 * (zero on a second run).
 *
 * Variants of a product whose slug already exists are still inserted if
 * their SKUs are new — that is intentional, the SKU is the variant's
 * natural key. If you delete a SKU and re-seed, the SKU comes back.
 *
 * We do NOT wrap the whole seed in a single transaction. The primary
 * use case is interactive developer setup; small per-table commits make
 * partial-progress retries cheap and avoid holding a transaction while
 * the developer reads the log output.
 */
export async function seedDemoCatalog(
  db: Db,
): Promise<DemoCatalogSeedSummary> {
  // -------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------
  const categoryRows: NewCategoryRow[] = CATEGORIES.map((c) => ({
    id: id("cat"),
    slug: c.slug,
    name: c.name,
    parentId: null,
  }));

  const insertedCategories = await db
    .insert(categories)
    .values(categoryRows)
    .onConflictDoNothing({ target: categories.slug })
    .returning({ slug: categories.slug });

  // Resolve slug → canonical id by reading every needed slug back. This
  // covers both first-run (our just-inserted ids) and re-run (existing
  // ids we never saw) without branching.
  const categoryIdBySlug = new Map<string, string>();
  for (const c of CATEGORIES) {
    const [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, c.slug))
      .limit(1);
    if (!row) {
      throw new Error(
        `seedDemoCatalog: category "${c.slug}" missing after insert — schema or constraint changed?`,
      );
    }
    categoryIdBySlug.set(c.slug, row.id);
  }

  // -------------------------------------------------------------------
  // Products + variants + inventory + product_categories
  // -------------------------------------------------------------------
  let productsInserted = 0;
  let variantsInserted = 0;
  let inventoryInserted = 0;
  let productCategoriesInserted = 0;

  for (const seedProduct of PRODUCTS) {
    // Insert the product or hit the slug conflict.
    const productRow: NewProductRow = {
      id: id("prod"),
      slug: seedProduct.slug,
      title: seedProduct.title,
      description: seedProduct.description,
      status: "active",
      defaultCurrency: CURRENCY,
      imageUrl: seedProduct.imageUrl,
      imageAlt: seedProduct.imageAlt,
    };
    const insertedProduct = await db
      .insert(products)
      .values(productRow)
      .onConflictDoNothing({ target: products.slug })
      .returning({ id: products.id });

    // Resolve to the canonical product id (existing or newly inserted).
    let productId: string;
    if (insertedProduct[0]) {
      productId = insertedProduct[0].id;
      productsInserted += 1;
    } else {
      const [existing] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.slug, seedProduct.slug))
        .limit(1);
      if (!existing) {
        // Should be unreachable: insert reported a conflict but no row exists.
        throw new Error(
          `seedDemoCatalog: product "${seedProduct.slug}" missing after conflict — race or schema change?`,
        );
      }
      productId = existing.id;
    }

    // Variants: keyed by SKU. Each variant gets its own inventory row.
    for (const seedVariant of seedProduct.variants) {
      const variantRow: NewProductVariantRow = {
        id: id("var"),
        productId,
        sku: seedVariant.sku,
        title: seedVariant.title,
        priceAmount: seedVariant.priceAmount,
        priceCurrency: CURRENCY,
        compareAtAmount: null,
      };
      const insertedVariant = await db
        .insert(productVariants)
        .values(variantRow)
        .onConflictDoNothing({ target: productVariants.sku })
        .returning({ id: productVariants.id });

      let variantId: string;
      if (insertedVariant[0]) {
        variantId = insertedVariant[0].id;
        variantsInserted += 1;
      } else {
        const [existing] = await db
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(eq(productVariants.sku, seedVariant.sku))
          .limit(1);
        if (!existing) {
          throw new Error(
            `seedDemoCatalog: variant "${seedVariant.sku}" missing after conflict`,
          );
        }
        variantId = existing.id;
      }

      // Inventory: a single NULL-location row per variant. The unique
      // constraint is enforced by partial indexes in the migration; we
      // SELECT first to avoid the partial-target ON CONFLICT footgun.
      const [existingInv] = await db
        .select({ id: inventoryLevels.id })
        .from(inventoryLevels)
        .where(eq(inventoryLevels.variantId, variantId))
        .limit(1);
      if (!existingInv) {
        const inventoryRow: NewInventoryLevelRow = {
          id: id("inv"),
          variantId,
          locationId: null,
          available: INITIAL_AVAILABLE,
          reserved: INITIAL_RESERVED,
        };
        await db.insert(inventoryLevels).values(inventoryRow);
        inventoryInserted += 1;
      }
    }

    // Product/category junctions. Composite PK is (product_id, category_id);
    // on conflict, the row already exists.
    const junctionRows: NewProductCategoryRow[] = seedProduct.categorySlugs.map(
      (slug) => {
        const categoryId = categoryIdBySlug.get(slug);
        if (!categoryId) {
          throw new Error(
            `seedDemoCatalog: product "${seedProduct.slug}" references unknown category slug "${slug}"`,
          );
        }
        return { productId, categoryId };
      },
    );
    if (junctionRows.length > 0) {
      const insertedJunctions = await db
        .insert(productCategories)
        .values(junctionRows)
        .onConflictDoNothing()
        .returning({ productId: productCategories.productId });
      productCategoriesInserted += insertedJunctions.length;
    }
  }

  const totalVariants = PRODUCTS.reduce((acc, p) => acc + p.variants.length, 0);
  const totalJunctions = PRODUCTS.reduce(
    (acc, p) => acc + p.categorySlugs.length,
    0,
  );

  return {
    categories: CATEGORIES.length,
    products: PRODUCTS.length,
    variants: totalVariants,
    inventoryLevels: totalVariants,
    productCategories: totalJunctions,
    inserted: {
      categories: insertedCategories.length,
      products: productsInserted,
      variants: variantsInserted,
      inventoryLevels: inventoryInserted,
      productCategories: productCategoriesInserted,
    },
  };
}

/** Test-only view of the static dataset for shape assertions. */
export const __seedDataForTesting = {
  categories: CATEGORIES,
  products: PRODUCTS,
} as const;
