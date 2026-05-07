/**
 * Mock product catalog for the storefront scaffold.
 *
 * This is replaced by `@mt-commerce/sdk` once it ships (see ADR-0008).
 * The shape here intentionally mirrors what the SDK is expected to return
 * for `storefront/v1/products` so swapping it in is a narrow change.
 *
 * Money amounts are stored as `bigint` in whole rupiah per ADR-0007.
 */
import type { Money } from "@mt-commerce/core/money";

export type Category = {
  id: string;
  slug: string;
  name: { id: string; en: string };
};

export type Variant = {
  id: string;
  name: { id: string; en: string };
  price: Money;
  compareAt?: Money;
  available: boolean;
};

export type Product = {
  id: string;
  slug: string;
  title: { id: string; en: string };
  description: { id: string; en: string };
  imageUrl: string;
  imageAlt: { id: string; en: string };
  categorySlug: string;
  variants: Variant[];
  /** ISO 8601 — used for "newest" sort. */
  createdAt: string;
  /** Computed convenience: lowest variant price. */
  basePrice: Money;
};

const idr = (amount: bigint): Money => ({ amount, currency: "IDR" });

export const MOCK_CATEGORIES: Category[] = [
  { id: "cat_kopi", slug: "kopi", name: { id: "Kopi", en: "Coffee" } },
  { id: "cat_batik", slug: "batik", name: { id: "Batik", en: "Batik" } },
  {
    id: "cat_kerajinan",
    slug: "kerajinan",
    name: { id: "Kerajinan", en: "Crafts" },
  },
  {
    id: "cat_makanan",
    slug: "makanan",
    name: { id: "Makanan", en: "Food" },
  },
];

export const MOCK_PRODUCTS: Product[] = [
  {
    id: "prod_kopi_gayo_200",
    slug: "kopi-arabika-gayo-200g",
    title: {
      id: "Kopi Arabika Gayo 200g",
      en: "Gayo Arabica Coffee 200g",
    },
    description: {
      id: "Biji kopi arabika dari dataran tinggi Gayo, Aceh. Sangrai medium.",
      en: "Arabica coffee beans from the Gayo highlands, Aceh. Medium roast.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Kopi+Gayo",
    imageAlt: {
      id: "Kemasan kopi arabika Gayo",
      en: "Bag of Gayo arabica coffee",
    },
    categorySlug: "kopi",
    variants: [
      {
        id: "var_kopi_gayo_whole",
        name: { id: "Biji utuh", en: "Whole bean" },
        price: idr(95_000n),
        available: true,
      },
      {
        id: "var_kopi_gayo_ground",
        name: { id: "Bubuk", en: "Ground" },
        price: idr(95_000n),
        available: true,
      },
    ],
    createdAt: "2026-04-12T08:00:00Z",
    basePrice: idr(95_000n),
  },
  {
    id: "prod_kopi_toraja_250",
    slug: "kopi-toraja-250g",
    title: {
      id: "Kopi Toraja 250g",
      en: "Toraja Coffee 250g",
    },
    description: {
      id: "Kopi arabika Toraja, Sulawesi Selatan. Profil rasa earthy dan rempah.",
      en: "Toraja arabica from South Sulawesi. Earthy, spiced flavor profile.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Kopi+Toraja",
    imageAlt: {
      id: "Kemasan kopi Toraja",
      en: "Bag of Toraja coffee",
    },
    categorySlug: "kopi",
    variants: [
      {
        id: "var_kopi_toraja_whole",
        name: { id: "Biji utuh", en: "Whole bean" },
        price: idr(125_000n),
        compareAt: idr(140_000n),
        available: true,
      },
    ],
    createdAt: "2026-04-20T08:00:00Z",
    basePrice: idr(125_000n),
  },
  {
    id: "prod_batik_tulis_pekalongan",
    slug: "batik-tulis-pekalongan",
    title: {
      id: "Batik Tulis Pekalongan",
      en: "Pekalongan Hand-drawn Batik",
    },
    description: {
      id: "Kain batik tulis motif pesisir Pekalongan. Pewarnaan alami.",
      en: "Hand-drawn batik with Pekalongan coastal motifs. Natural dyes.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Batik+Tulis",
    imageAlt: {
      id: "Kain batik tulis Pekalongan",
      en: "Pekalongan hand-drawn batik fabric",
    },
    categorySlug: "batik",
    variants: [
      {
        id: "var_batik_tulis_2m",
        name: { id: "2 meter", en: "2 meters" },
        price: idr(450_000n),
        available: true,
      },
      {
        id: "var_batik_tulis_4m",
        name: { id: "4 meter", en: "4 meters" },
        price: idr(850_000n),
        available: false,
      },
    ],
    createdAt: "2026-03-05T08:00:00Z",
    basePrice: idr(450_000n),
  },
  {
    id: "prod_batik_cap_solo",
    slug: "batik-cap-solo",
    title: {
      id: "Batik Cap Solo",
      en: "Solo Stamped Batik",
    },
    description: {
      id: "Batik cap motif klasik Solo. Bahan katun primissima.",
      en: "Stamped batik with classic Solo motifs. Primissima cotton.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Batik+Cap",
    imageAlt: {
      id: "Kain batik cap Solo",
      en: "Solo stamped batik fabric",
    },
    categorySlug: "batik",
    variants: [
      {
        id: "var_batik_cap_2m",
        name: { id: "2 meter", en: "2 meters" },
        price: idr(180_000n),
        available: true,
      },
    ],
    createdAt: "2026-02-18T08:00:00Z",
    basePrice: idr(180_000n),
  },
  {
    id: "prod_anyaman_rotan",
    slug: "keranjang-anyaman-rotan",
    title: {
      id: "Keranjang Anyaman Rotan",
      en: "Woven Rattan Basket",
    },
    description: {
      id: "Keranjang rotan anyaman tangan, ukuran sedang. Cocok untuk penyimpanan.",
      en: "Hand-woven rattan basket, medium size. Suitable for storage.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Keranjang+Rotan",
    imageAlt: {
      id: "Keranjang anyaman rotan",
      en: "Woven rattan basket",
    },
    categorySlug: "kerajinan",
    variants: [
      {
        id: "var_rotan_natural",
        name: { id: "Warna natural", en: "Natural" },
        price: idr(220_000n),
        available: true,
      },
      {
        id: "var_rotan_gelap",
        name: { id: "Warna gelap", en: "Dark" },
        price: idr(235_000n),
        available: true,
      },
    ],
    createdAt: "2026-04-01T08:00:00Z",
    basePrice: idr(220_000n),
  },
  {
    id: "prod_gerabah_kasongan",
    slug: "gerabah-kasongan",
    title: {
      id: "Gerabah Kasongan",
      en: "Kasongan Earthenware",
    },
    description: {
      id: "Vas gerabah dari Kasongan, Yogyakarta. Pembakaran tradisional.",
      en: "Earthenware vase from Kasongan, Yogyakarta. Traditional firing.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Gerabah",
    imageAlt: {
      id: "Vas gerabah Kasongan",
      en: "Kasongan earthenware vase",
    },
    categorySlug: "kerajinan",
    variants: [
      {
        id: "var_gerabah_kecil",
        name: { id: "Kecil", en: "Small" },
        price: idr(85_000n),
        available: true,
      },
      {
        id: "var_gerabah_besar",
        name: { id: "Besar", en: "Large" },
        price: idr(165_000n),
        compareAt: idr(190_000n),
        available: true,
      },
    ],
    createdAt: "2026-03-22T08:00:00Z",
    basePrice: idr(85_000n),
  },
  {
    id: "prod_keripik_tempe",
    slug: "keripik-tempe-malang",
    title: {
      id: "Keripik Tempe Malang",
      en: "Malang Tempe Chips",
    },
    description: {
      id: "Keripik tempe tipis dari Malang. Kemasan 200 gram.",
      en: "Thin tempe chips from Malang. 200 gram pack.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Keripik+Tempe",
    imageAlt: {
      id: "Kemasan keripik tempe",
      en: "Pack of tempe chips",
    },
    categorySlug: "makanan",
    variants: [
      {
        id: "var_keripik_original",
        name: { id: "Original", en: "Original" },
        price: idr(28_000n),
        available: true,
      },
      {
        id: "var_keripik_pedas",
        name: { id: "Pedas", en: "Spicy" },
        price: idr(28_000n),
        available: true,
      },
    ],
    createdAt: "2026-04-28T08:00:00Z",
    basePrice: idr(28_000n),
  },
  {
    id: "prod_kopi_kintamani",
    slug: "kopi-kintamani-200g",
    title: {
      id: "Kopi Kintamani 200g",
      en: "Kintamani Coffee 200g",
    },
    description: {
      id: "Arabika Kintamani, Bali. Catatan rasa jeruk dan bunga.",
      en: "Kintamani arabica from Bali. Citrus and floral notes.",
    },
    imageUrl: "https://placehold.co/800x800/png?text=Kopi+Kintamani",
    imageAlt: {
      id: "Kemasan kopi Kintamani",
      en: "Bag of Kintamani coffee",
    },
    categorySlug: "kopi",
    variants: [
      {
        id: "var_kopi_kintamani_whole",
        name: { id: "Biji utuh", en: "Whole bean" },
        price: idr(110_000n),
        available: true,
      },
    ],
    createdAt: "2026-05-01T08:00:00Z",
    basePrice: idr(110_000n),
  },
];
