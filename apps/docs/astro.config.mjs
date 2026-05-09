// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// `site` is required for canonical URLs and absolute links in metadata.
// Production builds should override the fallback via the `SITE` env var
// (set in CI or the deploy environment). Mirrors the storefront's pattern.
const SITE_URL = process.env.SITE ?? "https://docs.mt-commerce.example";

// External link target: leave as a placeholder pointing at the canonical
// repository path. The remote may not exist yet; once it does, this URL
// resolves to the live ADR directory.
const ADR_URL =
  "https://github.com/masyarakat-terbuka/mt-commerce/tree/main/docs/adr";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  integrations: [
    starlight({
      title: "mt-commerce",
      logo: {
        src: "./public/logo.png",
        alt: "mt-commerce",
        replacesTitle: false,
      },
      // Bahasa Indonesia is the source of truth and serves at `/`.
      // English mirrors live under `/en/`.
      defaultLocale: "id",
      locales: {
        id: { label: "Bahasa Indonesia", lang: "id" },
        en: { label: "English", lang: "en" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/masyarakat-terbuka/mt-commerce",
        },
      ],
      sidebar: [
        {
          label: "Pengantar",
          translations: { en: "Introduction" },
          link: "/",
        },
        {
          label: "Mulai cepat",
          translations: { en: "Quickstart" },
          link: "/quickstart",
        },
        {
          label: "Arsitektur",
          translations: { en: "Architecture" },
          link: "/architecture",
        },
        {
          label: "Konsep",
          translations: { en: "Concepts" },
          collapsed: true,
          items: [
            { label: "Produk", translations: { en: "Products" }, link: "/concepts/products" },
            { label: "Pesanan", translations: { en: "Orders" }, link: "/concepts/orders" },
            { label: "Pembayaran", translations: { en: "Payments" }, link: "/concepts/payments" },
            { label: "Pengiriman", translations: { en: "Shipping" }, link: "/concepts/shipping" },
            { label: "Notifikasi", translations: { en: "Notifications" }, link: "/concepts/notifications" },
            { label: "Plugin", translations: { en: "Plugins" }, link: "/concepts/plugins" },
          ],
        },
        {
          label: "Panduan admin",
          translations: { en: "Admin guide" },
          collapsed: true,
          items: [
            { label: "Pengantar", translations: { en: "Introduction" }, link: "/admin/intro" },
            { label: "Produk", translations: { en: "Products" }, link: "/admin/produk" },
            { label: "Pesanan", translations: { en: "Orders" }, link: "/admin/pesanan" },
            { label: "Pelanggan", translations: { en: "Customers" }, link: "/admin/pelanggan" },
            { label: "Inventaris", translations: { en: "Inventory" }, link: "/admin/inventaris" },
            { label: "Pengaturan", translations: { en: "Settings" }, link: "/admin/pengaturan" },
            { label: "Staf", translations: { en: "Staff" }, link: "/admin/staf" },
          ],
        },
        {
          label: "Plugin",
          translations: { en: "Plugins" },
          collapsed: true,
          items: [
            {
              label: "Panduan penulis plugin",
              translations: { en: "Author guide" },
              link: "/plugins/author-guide",
            },
            {
              label: "Pembayaran: Midtrans",
              translations: { en: "Payment: Midtrans" },
              link: "/plugins/payment-midtrans",
            },
            {
              label: "Pengiriman: Biteship",
              translations: { en: "Shipping: Biteship" },
              link: "/plugins/shipping-biteship",
            },
            {
              label: "Notifikasi: WhatsApp",
              translations: { en: "Notifications: WhatsApp" },
              link: "/plugins/notification-whatsapp",
            },
          ],
        },
        {
          label: "Penyebaran",
          translations: { en: "Deployment" },
          collapsed: true,
          items: [
            { label: "Mulai", translations: { en: "Getting started" }, link: "/deployment/getting-started" },
            { label: "Cadangan & pemulihan", translations: { en: "Backup & restore" }, link: "/deployment/backup-restore" },
            { label: "Firewall & SSL", translations: { en: "Firewall & SSL" }, link: "/deployment/firewall-ssl" },
            { label: "Biznet Gio", translations: { en: "Biznet Gio" }, link: "/deployment/biznet-gio" },
            { label: "IDCloudHost", translations: { en: "IDCloudHost" }, link: "/deployment/idcloudhost" },
          ],
        },
        {
          label: "Referensi API",
          translations: { en: "API reference" },
          collapsed: true,
          items: [
            {
              label: "Ikhtisar",
              translations: { en: "Overview" },
              link: "/api-reference",
            },
            {
              label: "Penjelajah",
              translations: { en: "Explorer" },
              link: "/api-reference/explorer",
            },
            {
              label: "Autentikasi",
              translations: { en: "Authentication" },
              link: "/api-reference/authentication",
            },
          ],
        },
        {
          label: "ADR",
          link: ADR_URL,
          attrs: { target: "_blank", rel: "noopener" },
        },
      ],
    }),
  ],
  // Astro 5.18 introduced a stricter config refinement that crashes when
  // `image.remotePatterns` is undefined; supplying an empty array keeps the
  // refiner happy. Mirrors the storefront's workaround.
  image: { remotePatterns: [] },
  // @astrojs/mdx 4.3 reads `config.markdown.{remarkPlugins,rehypePlugins}`
  // unconditionally; Astro 5.18 stopped defaulting them to empty arrays.
  // Defaulting here keeps the integration's `astro:config:done` hook from
  // crashing. Mirrors the storefront's workaround.
  markdown: { remarkPlugins: [], rehypePlugins: [] },
  output: "static",
});
