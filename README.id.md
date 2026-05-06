# mt-commerce

**Infrastruktur commerce open-source untuk Indonesia.**

Platform commerce modern yang bisa Anda jalankan, fork, dan miliki. Dibangun untuk pembayaran, pengiriman, dan bahasa Indonesia sejak awal. Gratis dengan lisensi permisif.

Oleh [Masyarakat Terbuka](https://github.com/masyarakat-terbuka).

> Status: dalam pengembangan awal. Bentuknya sudah ditetapkan; kodenya sedang ditulis secara terbuka.

> *Dokumen ini juga tersedia dalam [bahasa Inggris](./README.md).*

---

## Apa itu mt-commerce

mt-commerce adalah platform commerce headless. Intinya adalah API yang menangani semua kebutuhan toko — produk, pesanan, pelanggan, pembayaran, pengiriman, inventaris — dan sekumpulan aplikasi referensi (admin dan storefront) yang dibangun di atasnya.

Anda bisa menjalankan keseluruhan sistem di satu server kecil, mengganti frontend mana pun dengan milik Anda sendiri, atau memperluas mesin commerce melalui plugin. API adalah produk utamanya; aplikasi-aplikasi yang ada adalah contoh dari apa yang bisa dibangun di atasnya.

Tidak ada versi berbayar dari software ini. Kodenya adalah produknya.

---

## Apa yang dilakukannya

- **Produk, varian, dan inventaris** dengan struktur katalog yang realistis
- **Storefront** yang cepat di perangkat mobile dan koneksi yang lambat
- **Checkout** dengan QRIS, virtual account, e-wallet, transfer bank, dan COD
- **Integrasi pengiriman** dengan kurir yang digunakan orang Indonesia setiap hari
- **Admin** dalam Bahasa Indonesia, dirancang untuk pemilik toko, bukan engineer
- **Notifikasi pesanan WhatsApp** secara langsung tersedia
- **Platform untuk developer** dengan HTTP API terdokumentasi, webhook, event, plugin, dan SDK
- **Lokal sejak awal** — Rupiah, Bahasa Indonesia, alamat Indonesia hingga tingkat kelurahan, dan penanganan pajak lokal tanpa konfigurasi tambahan

---

## Arsitektur

mt-commerce dirancang headless secara sengaja. Tiga komponen utama, berkomunikasi melalui HTTP:

```
   ┌───────────────┐   ┌──────────────────┐   ┌──────────────┐
   │  Aplikasi     │   │  Storefront      │   │  Aplikasi    │
   │  Admin        │   │  (Astro)         │   │  Anda        │
   │  (React)      │   │                  │   │              │
   └───────┬───────┘   └────────┬─────────┘   └──────┬───────┘
           │                    │                    │
           └────────────────────┼────────────────────┘
                                ▼
                        ┌───────────────┐
                        │   API (Hono)  │
                        └───────┬───────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          PostgreSQL          Redis          Plugin
```

API adalah mesin utamanya. Admin dan storefront adalah klien referensi. Siapa pun bisa menggantinya, mem-fork, atau membangun yang sendiri.

Lihat [`ARCHITECTURE.md`](./ARCHITECTURE.md) untuk gambaran lengkapnya.

---

## Tech stack

- **API:** [Hono](https://hono.dev/) di [Bun](https://bun.sh/), TypeScript dari ujung ke ujung
- **Admin:** [Vite](https://vitejs.dev/) + [React](https://react.dev/)
- **Storefront:** [Astro](https://astro.build/) dengan React islands
- **Database:** [PostgreSQL](https://www.postgresql.org/)
- **Cache dan queue:** [Redis](https://redis.io/)
- **Pengembangan lokal:** [Docker Compose](https://docs.docker.com/compose/)

Alasan di balik setiap pilihan dijelaskan di [`docs/adr`](./docs/adr).

---

## Mulai cepat

> Langkah-langkah di bawah ini menggambarkan setup v0.1. Sampai v0.1 dirilis, repositori ini berisi dokumentasi saja — lihat [checklist v0.1](./docs/v0.1-checklist.md) untuk progresnya.

Anda perlu [Docker](https://www.docker.com/) dan [Bun](https://bun.sh/).

```bash
git clone https://github.com/masyarakat-terbuka/mt-commerce.git
cd mt-commerce

cp .env.example .env
docker compose up -d

# API di http://localhost:8000
# Admin di http://localhost:7000
# Storefront di http://localhost:3000
```

Setup default akan menjalankan API, database, cache, admin, dan storefront secara bersamaan. Panduan deployment produksi untuk hosting Indonesia dan internasional akan tersedia di `docs/deployment` setelah ditulis.

---

## Dokumentasi

- [Produk](./PRODUCT.md) — apa yang sedang dibangun dan mengapa
- [Arsitektur](./ARCHITECTURE.md) — bagaimana sistem ini dirancang
- [Checklist v0.1](./docs/v0.1-checklist.md) — apa yang ada di rilis pertama
- [Berkontribusi](./CONTRIBUTING.md) — bagaimana cara terlibat
- [Keamanan](./SECURITY.md) — cara melaporkan kerentanan secara bertanggung jawab

Dokumentasi lengkap, dalam Bahasa Indonesia dan Inggris, akan tersedia di `docs.masyarakat-terbuka.org` *(segera hadir)*.

---

## Untuk pedagang

Jika Anda ingin menjalankan toko di mt-commerce tetapi tidak ingin melakukan setup sendiri, cari agency atau developer mitra yang bisa membantu. Proyek ini terbuka, jadi siapa pun bisa menawarkan layanan ini. Kami akan mencantumkan mitra independen seiring berkembangnya komunitas.

---

## Untuk developer

mt-commerce dirancang untuk diperluas. Tema, plugin, modul, dan integrasi kustom adalah komponen utamanya. Baca [panduan kontribusi](./CONTRIBUTING.md) dan [gambaran arsitektur](./ARCHITECTURE.md) untuk memulai.

Kami menerima pull request, issue, dan diskusi dalam Bahasa Indonesia atau Inggris.

---

## Komunitas

- **Diskusi:** [GitHub Discussions](https://github.com/masyarakat-terbuka/mt-commerce/discussions)
- **Issue:** [GitHub Issues](https://github.com/masyarakat-terbuka/mt-commerce/issues)
- **Chat:** Discord *(segera hadir)*

Mohon baca [Code of Conduct](./CODE_OF_CONDUCT.md) sebelum berpartisipasi.

---

## Lisensi

[MIT](./LICENSE). Gunakan untuk apa pun, termasuk pekerjaan komersial. Atribusi diapresiasi tetapi tidak diwajibkan oleh lisensi.

---

## Tentang Masyarakat Terbuka

Masyarakat Terbuka adalah sekelompok kontributor yang membangun infrastruktur terbuka untuk Indonesia. mt-commerce adalah proyek pertamanya.
