import { describe, it, expect } from "vitest";
import { paginationItems } from "../../src/lib/pagination.ts";

function shape(items: ReturnType<typeof paginationItems>): string {
  return items
    .map((it) => (it.type === "ellipsis" ? "…" : String(it.page)))
    .join(" ");
}

describe("paginationItems", () => {
  it("returns a single page when totalPages is 1", () => {
    expect(shape(paginationItems(1, 1))).toBe("1");
  });

  it("renders short ranges without ellipsis", () => {
    // window=1: 1 2 3 covers everything; no gap → no ellipsis.
    expect(shape(paginationItems(2, 3))).toBe("1 2 3");
    expect(shape(paginationItems(3, 5))).toBe("1 2 3 4 5");
  });

  it("inserts an ellipsis when there's a gap", () => {
    // page 1 of 10: shows 1 2 … 10 (window around current is just page 1).
    expect(shape(paginationItems(1, 10))).toBe("1 2 … 10");
    // page 5 of 10: 1 … 4 5 6 … 10.
    expect(shape(paginationItems(5, 10))).toBe("1 … 4 5 6 … 10");
    // page 10 of 10: shows 1 … 9 10.
    expect(shape(paginationItems(10, 10))).toBe("1 … 9 10");
  });

  it("respects a wider window option", () => {
    expect(shape(paginationItems(5, 10, { window: 2 }))).toBe(
      "1 … 3 4 5 6 7 … 10",
    );
  });

  it("collapses adjacent boundaries instead of forcing an ellipsis", () => {
    // page 2 of 10, window=1: 1 2 3 are adjacent — only one trailing gap.
    expect(shape(paginationItems(2, 10))).toBe("1 2 3 … 10");
    // page 9 of 10: 8 9 10 adjacent — only one leading gap.
    expect(shape(paginationItems(9, 10))).toBe("1 … 8 9 10");
  });
});
