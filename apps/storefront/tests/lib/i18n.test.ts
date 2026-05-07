import { describe, it, expect } from "vitest";
import {
  createTranslator,
  resolveLocale,
  isLocale,
  localePath,
} from "../../src/lib/i18n.ts";

describe("i18n", () => {
  describe("createTranslator", () => {
    it("returns Indonesian strings for the id locale", () => {
      const t = createTranslator("id");
      expect(t("home.hero.title")).toBe("Mulai jualan online dengan toko Anda sendiri.");
      expect(t("nav.home")).toBe("Beranda");
      expect(t("products.detail.add_to_cart")).toBe("Tambah ke keranjang");
    });

    it("returns English strings for the en locale", () => {
      const t = createTranslator("en");
      expect(t("home.hero.title")).toBe("Start selling online with your own store.");
      expect(t("nav.home")).toBe("Home");
      expect(t("products.detail.add_to_cart")).toBe("Add to cart");
    });

    it("falls back to Indonesian for unsupported locales", () => {
      const t = createTranslator("fr");
      expect(t("nav.home")).toBe("Beranda");
    });

    it("returns the key itself for unknown keys", () => {
      const t = createTranslator("id");
      expect(t("nonexistent.key")).toBe("nonexistent.key");
    });
  });

  describe("resolveLocale", () => {
    it("returns the input when supported", () => {
      expect(resolveLocale("id")).toBe("id");
      expect(resolveLocale("en")).toBe("en");
    });

    it("falls back to id for unknown or empty values", () => {
      expect(resolveLocale("fr")).toBe("id");
      expect(resolveLocale(undefined)).toBe("id");
      expect(resolveLocale(null)).toBe("id");
    });
  });

  describe("isLocale", () => {
    it("recognizes supported locales only", () => {
      expect(isLocale("id")).toBe(true);
      expect(isLocale("en")).toBe(true);
      expect(isLocale("fr")).toBe(false);
      expect(isLocale(123)).toBe(false);
    });
  });

  describe("localePath", () => {
    it("returns the bare path for the default locale", () => {
      expect(localePath("id", "/products")).toBe("/products");
      expect(localePath("id", "/")).toBe("/");
    });

    it("prefixes the path for non-default locales", () => {
      expect(localePath("en", "/products")).toBe("/en/products");
      expect(localePath("en", "/")).toBe("/en");
    });
  });
});
