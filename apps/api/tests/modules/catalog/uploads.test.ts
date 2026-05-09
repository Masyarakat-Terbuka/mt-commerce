/**
 * Unit tests for the product image upload helper.
 *
 * Each test runs against a fresh temp directory so we never collide with
 * a developer's local `apps/api/uploads` and we never need to clean up
 * shared state between tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeProductImage } from "../../../src/modules/catalog/uploads.js";
import { ValidationError } from "../../../src/lib/errors.js";

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

// 'RIFF' + 4 dummy size bytes + 'WEBP' header.
const WEBP_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function pad(header: Uint8Array, totalSize: number): Uint8Array {
  if (header.length >= totalSize) return header;
  const out = new Uint8Array(totalSize);
  out.set(header, 0);
  // Fill the rest with deterministic bytes so the SHA-256 stays stable
  // across runs and the file size matches what we asked for.
  for (let i = header.length; i < totalSize; i += 1) {
    out[i] = (i * 31) & 0xff;
  }
  return out;
}

describe("storeProductImage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mt-uploads-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(maxBytes = 5 * 1024 * 1024) {
    return {
      uploadDir: dir,
      apiPublicUrl: "http://localhost:8000",
      maxBytes,
    };
  }

  it("writes a PNG to disk and returns a public URL", async () => {
    const bytes = pad(PNG_HEADER, 256);
    const stored = await storeProductImage(
      { bytes, contentType: "image/png" },
      deps(),
    );

    expect(stored.size).toBe(256);
    expect(stored.mimeType).toBe("image/png");
    expect(stored.filename).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(stored.url).toBe(`http://localhost:8000/uploads/${stored.filename}`);

    const onDisk = await readFile(join(dir, stored.filename));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("accepts JPEG with the FF D8 FF magic bytes", async () => {
    const bytes = pad(JPEG_HEADER, 64);
    const stored = await storeProductImage(
      { bytes, contentType: "image/jpeg" },
      deps(),
    );

    expect(stored.mimeType).toBe("image/jpeg");
    expect(stored.filename).toMatch(/\.jpg$/);
  });

  it("accepts WebP with the RIFF/WEBP container header", async () => {
    const bytes = pad(WEBP_HEADER, 128);
    const stored = await storeProductImage(
      { bytes, contentType: "image/webp" },
      deps(),
    );

    expect(stored.mimeType).toBe("image/webp");
    expect(stored.filename).toMatch(/\.webp$/);
  });

  it("strips charset parameters from the content-type header", async () => {
    const bytes = pad(PNG_HEADER, 32);
    const stored = await storeProductImage(
      { bytes, contentType: "image/png; charset=binary" },
      deps(),
    );
    expect(stored.mimeType).toBe("image/png");
  });

  it("deduplicates identical bytes to the same filename", async () => {
    const bytes = pad(PNG_HEADER, 64);
    const first = await storeProductImage(
      { bytes, contentType: "image/png" },
      deps(),
    );
    const second = await storeProductImage(
      { bytes, contentType: "image/png" },
      deps(),
    );

    expect(second.filename).toBe(first.filename);
    expect(second.url).toBe(first.url);
    // Same file on disk — no double-write surfacing as a different size.
    const info = await stat(join(dir, second.filename));
    expect(info.size).toBe(bytes.length);
  });

  it("rejects an unsupported MIME type", async () => {
    const bytes = pad(PNG_HEADER, 32);
    await expect(
      storeProductImage({ bytes, contentType: "image/gif" }, deps()),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a content-type/magic-byte mismatch", async () => {
    // PNG bytes declared as JPEG.
    const bytes = pad(PNG_HEADER, 64);
    await expect(
      storeProductImage({ bytes, contentType: "image/jpeg" }, deps()),
    ).rejects.toThrow(/do not match/);
  });

  it("rejects an empty file", async () => {
    await expect(
      storeProductImage(
        { bytes: new Uint8Array(0), contentType: "image/png" },
        deps(),
      ),
    ).rejects.toThrow(/empty/);
  });

  it("rejects oversized uploads", async () => {
    const bytes = pad(PNG_HEADER, 1024);
    await expect(
      storeProductImage(
        { bytes, contentType: "image/png" },
        deps(/* maxBytes */ 512),
      ),
    ).rejects.toThrow(/limit/);
  });

  it("creates the upload directory if it does not yet exist", async () => {
    const nested = join(dir, "deep", "nested");
    const bytes = pad(PNG_HEADER, 32);
    const stored = await storeProductImage(
      { bytes, contentType: "image/png" },
      { ...deps(), uploadDir: nested },
    );
    const info = await stat(join(nested, stored.filename));
    expect(info.size).toBe(bytes.length);
  });

  it("handles trailing slashes on the public URL gracefully", async () => {
    const bytes = pad(PNG_HEADER, 32);
    const stored = await storeProductImage(
      { bytes, contentType: "image/png" },
      { ...deps(), apiPublicUrl: "http://localhost:8000//" },
    );
    expect(stored.url).toBe(`http://localhost:8000/uploads/${stored.filename}`);
  });
});
