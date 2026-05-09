/**
 * `ProductsPage` async-state tests.
 *
 * Covers the four render states the page can be in:
 *
 *   - loading (skeleton rows on first paint)
 *   - error (destructive alert + retry button)
 *   - empty (the `<Empty>` block + "create first product" CTA)
 *   - data (one row per product)
 *
 * The page reaches into TanStack Router's `<Link>` for the row's edit
 * action and the empty-state CTA. We stub the router with a plain anchor
 * so the rendered DOM still contains the link without standing up a
 * memory-history router (overkill for these tests). The API is mocked at
 * `@/lib/api` so the test owns the resolved value of every query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../renderWithProviders";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, unknown>;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

const listMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    admin: {
      products: {
        list: (...args: unknown[]) => listMock(...args),
      },
    },
  },
  ApiError: class ApiError extends Error {},
}));

import { ProductsPage } from "@/pages/ProductsPage";

beforeEach(() => {
  listMock.mockReset();
});

describe("ProductsPage", () => {
  it("renders skeleton rows while the first list request is in flight", () => {
    listMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderWithProviders(<ProductsPage />);
    // Skeleton component renders elements with `data-slot="skeleton"`.
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders the destructive error alert when the list call rejects", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderWithProviders(<ProductsPage />);
    expect(
      await screen.findByText("Could not load products. Please try again."),
    ).toBeInTheDocument();
    // The retry button must be labelled "Retry", not "Loading…" — this
    // pins the bug the inventory/products list both shipped with.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders the empty state when the API returns zero rows", async () => {
    listMock.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    renderWithProviders(<ProductsPage />);
    expect(await screen.findByText("No products yet.")).toBeInTheDocument();
    // The CTA renders the localized label; we assert on the visible text
    // rather than the accessible role/name because the Radix `Slot`-based
    // Button merges props onto the inner Link in a way that doesn't carry
    // a bare `link` role through reliably in jsdom.
    expect(screen.getByText("Create your first product")).toBeInTheDocument();
  });

  it("renders one row per product when data is present", async () => {
    listMock.mockResolvedValue({
      data: [
        {
          id: "prd_1",
          slug: "kemeja-linen",
          title: "Kemeja Linen",
          status: "active",
          defaultCurrency: "IDR",
          imageUrl: null,
          imageAlt: null,
          updatedAt: new Date("2026-05-01T00:00:00Z"),
          variants: [],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderWithProviders(<ProductsPage />);
    expect(await screen.findByText("Kemeja Linen")).toBeInTheDocument();
    expect(screen.getByText("kemeja-linen")).toBeInTheDocument();
    expect(screen.getByText("IDR")).toBeInTheDocument();
    // The "Edit" affordance is present — assert on the visible label
    // (the Radix `Slot` button-as-link merges props in a way that
    // doesn't surface a stable `link` role in jsdom).
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("does not render the data table while the error alert is showing", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderWithProviders(<ProductsPage />);
    await waitFor(() => {
      expect(
        screen.getByText("Could not load products. Please try again."),
      ).toBeInTheDocument();
    });
    // The error path replaces the table; the column headers must be gone.
    expect(screen.queryByText(/Updated/i)).not.toBeInTheDocument();
  });
});
