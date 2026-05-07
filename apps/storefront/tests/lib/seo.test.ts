import { describe, it, expect } from "vitest";
import { jsonLdString, buildHreflangPair, ogLocale } from "../../src/lib/seo.ts";

describe("seo", () => {
  describe("jsonLdString", () => {
    it("escapes </ so a payload cannot break out of <script>", () => {
      // The classic XSS vector: a value contains a literal "</script>"
      // substring. The HTML parser, in script-data state, would otherwise
      // close the script tag. The helper must escape `</` to `<\/`.
      const out = jsonLdString({ blurb: "danger </script><img src=x onerror=alert(1)>" });
      expect(out).not.toContain("</script");
      expect(out).toContain("<\\/script");
    });

    it("escapes U+2028 / U+2029 separators", () => {
      // Use String.fromCharCode so this test file holds no raw control
      // bytes — keeps editors and lint happy.
      const ls = String.fromCharCode(0x2028);
      const ps = String.fromCharCode(0x2029);
      const out = jsonLdString({ a: `line${ls}break`, b: `para${ps}sep` });
      expect(out).toContain("\\u2028");
      expect(out).toContain("\\u2029");
      // Raw separators must be gone.
      expect(out).not.toContain(ls);
      expect(out).not.toContain(ps);
    });

    it("round-trips back to the original payload via JSON.parse", () => {
      // Sanity check: the escaping must keep the JSON valid. JSON
      // accepts `\/` as a synonym for `/`, so the parser sees the
      // original string when the script element runs.
      const payload = {
        "@type": "Product",
        name: "Tile </script>",
        url: "https://example.com/products/x",
      };
      const out = jsonLdString(payload);
      expect(JSON.parse(out)).toEqual(payload);
    });

    it("accepts an array payload", () => {
      const out = jsonLdString([{ a: 1 }, { b: 2 }]);
      expect(out).toBe('[{"a":1},{"b":2}]');
    });
  });

  describe("buildHreflangPair", () => {
    const site = "https://example.com";

    it("returns id at root and en under /en for the default-locale path", () => {
      const out = buildHreflangPair("/", site);
      expect(out.id).toBe("https://example.com/");
      expect(out.en).toBe("https://example.com/en");
      expect(out.xDefault).toBe(out.id);
    });

    it("strips the en prefix when input is on the en locale", () => {
      const out = buildHreflangPair("/en/products", site);
      expect(out.id).toBe("https://example.com/products");
      expect(out.en).toBe("https://example.com/en/products");
      expect(out.xDefault).toBe(out.id);
    });

    it("preserves nested paths", () => {
      const out = buildHreflangPair("/products/some-slug", site);
      expect(out.id).toBe("https://example.com/products/some-slug");
      expect(out.en).toBe("https://example.com/en/products/some-slug");
    });

    it("treats an unknown prefix as already on the default locale", () => {
      // We currently support only id/en. A path under a hypothetical
      // future locale (e.g. /jp) should be left alone on the id side
      // and prefixed for en — the prefix-stripping is intentionally
      // narrow.
      const out = buildHreflangPair("/jp/products", site);
      expect(out.id).toBe("https://example.com/jp/products");
      expect(out.en).toBe("https://example.com/en/jp/products");
    });
  });

  describe("ogLocale", () => {
    it("maps short locales to BCP47-with-underscore", () => {
      expect(ogLocale("id")).toBe("id_ID");
      expect(ogLocale("en")).toBe("en_US");
    });
  });
});
