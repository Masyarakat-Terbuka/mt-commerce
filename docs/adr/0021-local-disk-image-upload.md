# ADR-0021: Local-disk product image upload for v0.1

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** mt-commerce maintainers

---

## Context

Operators need to upload product images from the admin. The previous shape — paste an external URL into the product editor — works for merchants who already host their photos somewhere, but is friction for everyone else and a footgun (linked images go 404 when the source disappears, or get hot-linked-blocked, or change unannounced).

The original `ARCHITECTURE.md` listed file storage as one of the deliberately-deferred decisions:

> File storage (local disk for the first releases; an S3-compatible adapter later)

This ADR records that decision in concrete form, captures the v0.1 implementation, and pins the seam where a future S3 adapter swaps in.

The deployment shape we are designing for: one VPS, one api process, one Postgres, optional Redis. The api serves the storefront on the same machine. Operators target Hetzner / Biznet Gio / IDCloudHost — not "we have an S3 account, give us the bucket name."

---

## Decision

v0.1 stores uploaded product images **on the api process's local disk**. Images live under a configurable directory (`UPLOAD_DIR`, default `./uploads`). The api serves them back as static files at `/uploads/<filename>` with a long cache-control header.

The upload pipeline at `apps/api/src/modules/catalog/uploads.ts`:

1. The admin POSTs `multipart/form-data` to `POST /admin/v1/products/{id}/upload-image` with the file part.
2. The route validates the size cap (`MAX_UPLOAD_BYTES`, default 5MiB) at the multipart layer.
3. The service validates the MIME type against an accepted set (`image/jpeg`, `image/png`, `image/webp`) AND checks the magic bytes against the declared MIME — a renamed `.html` with `Content-Type: image/png` is rejected.
4. The filename is `sha256(content).slice(0, 16) + ext`. Identical content deduplicates: re-uploading the same photo writes the same filename. The hash also makes filenames non-guessable.
5. The service writes the file to disk (creating the directory if absent) and returns `{ filename, url, size, mimeType }`. The route composes that with `CatalogService.updateProduct` to persist the URL on the product row.
6. The public URL is `${API_PUBLIC_URL}/uploads/<filename>` — absolute, so the storefront renders it as-is with no client-side path helper.

The api mounts a static-file middleware on `/uploads/*` pointed at `UPLOAD_DIR` and configured with a one-year `Cache-Control: public, max-age=31536000, immutable`. Filenames are content-hashed, so an updated photo is a new filename — the cache is correct under that contract.

The directory is **not** in the repository's git history. Deployment scripts mount it as a volume (`docker compose` uses a named volume; bare-metal deploys keep it under `/var/lib/mt-commerce/uploads`). The deployment guide spells the volume mount out.

---

## Consequences

### Positive

A v0.1 deployment is one process, one disk. There is no S3 account to register, no IAM policy to write, no bucket to scope, no signed-URL generator to maintain. An operator on a fresh VPS uploads their first product image without a credit card on file at AWS.

The hash-named filename gives content-addressed deduplication. Re-uploading the same product photo across ten products writes one file. The old "paste URL" shape gave us nothing here; the new shape is strictly better on disk usage.

The static-file middleware is the same pattern Hono ships out of the box. There is no custom serving layer, no streaming code path that we own and have to keep secure. The cache-control header is set once and works because filenames are immutable by design.

The seam for S3 is small. The upload service returns `{ filename, url, ... }`; only the writer (write to disk) and the URL builder (concat into the public URL) know where the bytes go. A future S3 adapter implements `writeBlob(bytes, contentType)` and `urlFor(filename)`; everything else stays. We resist abstracting it now (YAGNI) but the call sites already go through the seam.

The validation pipeline catches the common attacks: oversized uploads die at the multipart parser, MIME-spoofed files die on the magic-byte check, and a malicious `.svg` (which can carry script) is rejected because SVG isn't in the accepted set. The upload surface in v0.1 is image-only by design.

### Negative

**Multi-process deployments don't share the disk.** A v0.5 that runs two api processes behind a load balancer will see uploads land on whichever instance accepted the POST and not be visible from the other. Operators who need that today must either pin uploads to a specific instance with a sticky balancer or run a shared-volume mount (NFS, EFS) — neither is good. The S3 adapter is the right answer when this becomes real.

**Backups are the operator's job.** The `uploads/` directory is data, not code; `pg_dump` does not cover it. The deployment guide tells operators to back up the volume alongside the database, but a merchant who skips that step loses every product photo on a disk failure. We accept this for v0.1 with explicit documentation; a managed-storage adapter would relieve the operator of remembering.

**Disk fills up.** Without orphan cleanup, every product update that swaps the image leaves the old file behind (the hash filename means the URL on the product row changes, but nothing deletes the orphan). A future v0.x adds a sweeper that scans the products table for referenced filenames and deletes the rest. v0.1 ships without it; the disk-usage growth on a small store is bounded by usage but unbounded over time.

**The api process gets bigger memory peaks during multipart parsing.** Bun's multipart parser holds the body in memory before it hits the validator. Upload caps at 5MiB, so the worst case is N concurrent admin uploads × 5MiB; on a 2GiB VPS that is fine for v0.1 admin volume. Streaming-to-disk would lift the cap, and is the right move when a future operator wants to upload 50MiB videos.

**No image processing.** v0.1 stores the original. No thumbnail, no WebP conversion, no resizing. The storefront emits the original asset to the buyer's browser and lets the browser scale. For most product photos the size is adequate; for high-resolution photographs it is wasteful. Image processing is a separate ADR when it lands; sharp + a per-size cache on disk is the obvious shape.

---

## What v0.1 does NOT do

- **External storage adapters.** No S3, no R2, no GCS, no Cloudinary. The seam is in the upload service; the adapter ships when a deployment needs it.
- **Image processing.** No thumbnails, no format conversion, no responsive `srcset`. The original is what the buyer sees.
- **Public uploads.** The route is `/admin/v1/products/{id}/upload-image` and is gated by the `staff` role. There is no customer-facing upload (avatar, review photo, return-claim image).
- **Non-image uploads.** PDF invoices, CSV exports, etc., are not produced through this surface. The accepted MIME types are image-only.
- **Orphan cleanup.** A product that swaps its image leaves the old file on disk. A future sweeper handles this.
- **Multi-region replication.** Single-region. The S3 adapter would solve this; v0.1 does not.
- **Per-store quotas.** Single-tenant per deployment (see ADR-0016). Quotas are a multi-tenant concern.

---

## Alternatives considered

### S3-compatible storage from day one

Considered. Rejected because:

- The merchant audience for v0.1 explicitly includes operators who do not have S3 credentials and would need to register, set up IAM, configure CORS, and pay a monthly minimum to make their store work. The deployment story is "docker compose up"; an S3 dependency breaks that.
- The S3 SDK is non-trivial dependency weight (≈4MB on the api), traded for a feature most v0.1 deployments don't need.
- The seam exists either way; choosing local-disk for v0.1 doesn't preclude shipping S3 later. Choosing S3 for v0.1 _would_ preclude operators who can't use it.

A self-hosted MinIO is the next-best fit (S3 API, on-prem) but adds another container to the deployment topology. We may add a MinIO recipe in the deployment guide once the S3 adapter ships; v0.1 does not.

### Database BLOB storage

`bytea` columns or `pg_largeobject`. Rejected because:

- pg_dump payloads grow with image volume; restores get slow.
- Postgres is not designed for serving binary content under buyer-facing latency targets. Even with a CDN in front, the round trip through the connection pool is wasteful.
- We would need to invent a streaming pattern to avoid loading the whole image into memory on read.

### A separate file-server process

A small Caddy or nginx container serving `/uploads/*` from the same volume. Considered for offloading the static file path off the Bun process. Rejected because:

- The deployment story stays simpler with one process. Adding a second container is not free for an operator setting up their first VPS.
- Bun's static-file middleware is fast enough for v0.1 traffic. There is no measured performance problem to solve.

We may revisit when a deployment is large enough that the api process is bottlenecked on serving static assets — but the cure for that is "put a CDN in front" or "move to S3", not "split the static-file responsibility into a sidecar."

### A direct-to-CDN flow (presigned URL upload)

Browser uploads directly to S3/Cloudinary using a presigned URL minted by the api. Rejected for v0.1 because:

- Requires an external storage adapter (we are not shipping one).
- Adds a CORS configuration the operator must maintain.
- Validation (MIME, magic bytes, size cap) becomes harder — the file does not pass through the api before landing.

This is the right shape for a v0.5 with the S3 adapter and merchants pushing high-resolution video. v0.1 does not need it.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module boundaries; uploads live in the catalog module.
- [ADR-0011](./0011-audit-log.md) — every product update (including the URL swap from an upload) is audited.
- `apps/api/src/modules/catalog/uploads.ts` — the upload service and the validation pipeline.
- `apps/api/src/modules/catalog/routes/admin.ts` — the upload route.
- `apps/api/src/lib/env.ts` — `UPLOAD_DIR`, `MAX_UPLOAD_BYTES`, `API_PUBLIC_URL` env knobs.
- `ARCHITECTURE.md` — the "Open questions" line that originally deferred this decision.
