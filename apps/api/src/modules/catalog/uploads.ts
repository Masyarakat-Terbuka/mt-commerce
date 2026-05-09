/**
 * Product image upload — accept a file, validate it, and write it to disk.
 *
 * Storage strategy:
 *   - Files land in `env.uploadDir`. The directory is created on first
 *     write so the deployer does not have to remember a `mkdir`.
 *   - Filename is the first 16 hex chars of the file's SHA-256 plus the
 *     content-derived extension. Identical bytes deduplicate to the same
 *     filename — uploading the same image twice does not double the disk
 *     footprint.
 *   - Public URL is `${env.apiPublicUrl}/uploads/${filename}`. Stored
 *     absolute so the storefront can render the URL as-is, with no path-
 *     resolution helper. In a future move to S3/CDN, only this builder
 *     needs to change.
 *
 * Validation:
 *   - MIME type must be in the accepted set (jpeg, png, webp).
 *   - Magic bytes are checked against the declared MIME — a `.png`
 *     uploaded as `image/jpeg` is rejected, and so is an HTML file with
 *     a spoofed Content-Type.
 *   - Size capped at `env.maxUploadBytes`. The route is responsible for
 *     refusing oversized requests early (the multipart parser still
 *     drains them otherwise); this layer rejects after the fact too.
 *
 * The service does not touch the products table — it returns a stored
 * file shape. The route layer composes the upload result with
 * `CatalogService.updateProduct` to persist the new `imageUrl`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ValidationError } from "../../lib/errors.js";

/** Accepted MIME types — keep in sync with `MAGIC_PREFIXES` below. */
export const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

const EXT_BY_MIME: Record<AcceptedMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Magic-byte prefixes that uniquely identify each accepted image format.
 *
 * - JPEG starts `FF D8 FF`.
 * - PNG starts `89 50 4E 47 0D 0A 1A 0A`.
 * - WebP is a RIFF container: `52 49 46 46 .. .. .. .. 57 45 42 50`. We
 *   check the `RIFF` prefix and the `WEBP` chunk type at offset 8.
 *
 * A Content-Type header is a hint; the magic bytes are the truth.
 */
const MAGIC_PREFIXES: Record<AcceptedMimeType, (bytes: Uint8Array) => boolean> =
  {
    "image/jpeg": (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
    "image/png": (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
    "image/webp": (bytes) =>
      bytes.length >= 12 &&
      bytes[0] === 0x52 && // 'R'
      bytes[1] === 0x49 && // 'I'
      bytes[2] === 0x46 && // 'F'
      bytes[3] === 0x46 && // 'F'
      bytes[8] === 0x57 && // 'W'
      bytes[9] === 0x45 && // 'E'
      bytes[10] === 0x42 && // 'B'
      bytes[11] === 0x50, // 'P'
  };

export interface UploadInput {
  /** The uploaded file's bytes. */
  bytes: Uint8Array;
  /**
   * MIME type as declared by the multipart layer. Must be in
   * `ACCEPTED_MIME_TYPES`; the magic-byte check below confirms.
   */
  contentType: string;
}

export interface StoredImage {
  /** Filename written under `env.uploadDir`, e.g. `8a2b...c5.jpg`. */
  filename: string;
  /** Absolute URL the storefront renders (`${apiPublicUrl}/uploads/...`). */
  url: string;
  /** Bytes written. Mirrors `input.bytes.length`. */
  size: number;
  /** Confirmed MIME type after the magic-byte check. */
  mimeType: AcceptedMimeType;
}

export interface UploadDeps {
  /** Directory uploads are written to. Absolute or relative to `cwd()`. */
  uploadDir: string;
  /** Public API origin used to build the returned URL. No trailing slash. */
  apiPublicUrl: string;
  /** Max bytes per upload. Re-checked here as defense in depth. */
  maxBytes: number;
}

/**
 * Validate, hash, and write a product image upload.
 *
 * Throws `ValidationError` on type/size/magic-byte failures. The route
 * layer maps that to a 400 with the standard envelope.
 */
export async function storeProductImage(
  input: UploadInput,
  deps: UploadDeps,
): Promise<StoredImage> {
  const declared = input.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!isAcceptedMimeType(declared)) {
    throw new ValidationError(
      `Unsupported image type "${declared}". Accepted: ${ACCEPTED_MIME_TYPES.join(", ")}.`,
      { contentType: declared },
    );
  }

  if (input.bytes.length === 0) {
    throw new ValidationError("Uploaded file is empty.", { size: 0 });
  }
  if (input.bytes.length > deps.maxBytes) {
    throw new ValidationError(
      `Uploaded file is ${input.bytes.length} bytes; the limit is ${deps.maxBytes}.`,
      { size: input.bytes.length, limit: deps.maxBytes },
    );
  }

  const magicMatch = MAGIC_PREFIXES[declared](input.bytes);
  if (!magicMatch) {
    throw new ValidationError(
      "Uploaded file's contents do not match the declared image type.",
      { contentType: declared },
    );
  }

  const hashHex = await sha256Hex(input.bytes);
  const filename = `${hashHex.slice(0, 32)}.${EXT_BY_MIME[declared]}`;

  const absoluteDir = resolve(deps.uploadDir);
  await mkdir(absoluteDir, { recursive: true });
  const targetPath = resolve(absoluteDir, filename);
  await writeFile(targetPath, input.bytes);

  const trimmedBase = deps.apiPublicUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/uploads/${filename}`;

  return {
    filename,
    url,
    size: input.bytes.length,
    mimeType: declared,
  };
}

function isAcceptedMimeType(value: string): value is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Web-Crypto SubtleCrypto is available in Bun and Node 22+.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
