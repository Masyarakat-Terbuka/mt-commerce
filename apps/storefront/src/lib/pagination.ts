/**
 * pagination — truncation logic for page-number lists.
 *
 * Returns the items to render in a "1 … 4 5 6 … 12" style nav: a mix of
 * page numbers and "ellipsis" markers. Always includes the first and last
 * pages plus a sliding window around the current page; gaps between those
 * groups collapse to a single ellipsis. For short ranges (totalPages ≤ the
 * combined width of the two end pages plus the window on each side, plus
 * a gap), all numbers render — the ellipsis only appears when truncation
 * actually saves room.
 */

export type PaginationItem =
  | { type: "page"; page: number }
  | { type: "ellipsis"; key: string };

export interface PaginationOptions {
  /**
   * Number of page numbers to show on each side of the current page.
   * Default 1 → "… 4 5 6 …" around page 5. Listing pages with deep
   * catalogs may want 2 for a wider window.
   */
  window?: number;
}

/**
 * Build the list of pagination items for a 1-based page in a totalPages
 * range. The output always begins with page 1 and ends with totalPages
 * (when totalPages > 1). Ellipsis markers carry a stable `key` so React
 * keys don't collide.
 */
export function paginationItems(
  page: number,
  totalPages: number,
  options: PaginationOptions = {},
): PaginationItem[] {
  const window = Math.max(0, options.window ?? 1);
  if (totalPages <= 1) return [{ type: "page", page: 1 }];

  // Pages we definitely want to render: 1, totalPages, and the window
  // around the current page (clamped into range).
  const pages = new Set<number>();
  pages.add(1);
  pages.add(totalPages);
  for (let p = page - window; p <= page + window; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    items.push({ type: "page", page: p });
    const next = sorted[i + 1];
    if (next !== undefined && next - p > 1) {
      items.push({ type: "ellipsis", key: `gap-${p}-${next}` });
    }
  }
  return items;
}
