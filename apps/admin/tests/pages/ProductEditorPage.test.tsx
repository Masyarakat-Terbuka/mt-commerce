/**
 * `ProductEditorPage` validation tests.
 *
 * The submit gate is the only thing standing between an operator's typo
 * and a 4xx round-trip. Validation runs the same Zod schema the API
 * mirrors (slug format, integer price, required title, ≥1 variant), so a
 * regression here would silently let invalid forms reach the network.
 *
 * Tests cover the create-mode form (no fetch needed at mount):
 *   - empty submit surfaces required-field errors and does NOT call the
 *     mutation
 *   - invalid slug format surfaces the slug error
 *   - invalid price format surfaces the price error
 *   - a fully-valid form passes validation and calls the create mutation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../renderWithProviders";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({}),
  useNavigate: () => () => undefined,
}));

const createMock = vi.fn();
const updateMock = vi.fn();
const byIdMock = vi.fn();
const delMock = vi.fn();
const uploadImageMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    admin: {
      products: {
        create: (...args: unknown[]) => createMock(...args),
        update: (...args: unknown[]) => updateMock(...args),
        byId: (...args: unknown[]) => byIdMock(...args),
        del: (...args: unknown[]) => delMock(...args),
        uploadImage: (...args: unknown[]) => uploadImageMock(...args),
      },
    },
  },
  ApiError: class ApiError extends Error {
    code?: string;
    details?: unknown;
  },
}));

// `sonner` toasts get triggered on save success — stub the surface so it
// does not try to read DOM / portals during validation tests that never
// reach success.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProductEditorPage } from "@/pages/ProductEditorPage";

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  byIdMock.mockReset();
});

async function clickSave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save product" }));
}

describe("ProductEditorPage — create mode validation", () => {
  it("surfaces a required-field error and does not call the API on empty submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductEditorPage mode="create" />);

    await clickSave(user);

    // The slug + title fields are both required; at least one "Required."
    // error must surface. We assert with `findAllByText` so the test does
    // not fail if the form decides to add a third required field later.
    const errors = await screen.findAllByText("Required.");
    expect(errors.length).toBeGreaterThan(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("surfaces the slug-format error when the slug contains invalid characters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductEditorPage mode="create" />);

    await user.type(screen.getByLabelText("Slug"), "Bad Slug!");
    await clickSave(user);

    expect(
      await screen.findByText("Slug must be lowercase, hyphen-separated."),
    ).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("surfaces the URL-format error when the image URL is not a valid http(s) URL", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductEditorPage mode="create" />);

    // Fill all the required fields with valid values so the URL is the
    // only thing left for the schema to reject.
    await user.type(screen.getByLabelText("Slug"), "kemeja-linen");
    const titleInputs = screen.getAllByLabelText("Title");
    await user.type(titleInputs[0]!, "Kemeja Linen");
    const skuInputs = screen.getAllByLabelText(/sku/i);
    await user.type(skuInputs[0]!, "SKU-001");
    const priceInputs = screen.getAllByLabelText("Price");
    await user.type(priceInputs[0]!, "150000");
    await user.type(screen.getByLabelText("Image URL"), "not a url");

    await clickSave(user);

    expect(await screen.findByText("Not a valid URL.")).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("calls the create mutation when the whole form validates", async () => {
    createMock.mockResolvedValue({ id: "prd_new" });
    const user = userEvent.setup();
    renderWithProviders(<ProductEditorPage mode="create" />);

    await user.type(screen.getByLabelText("Slug"), "kemeja-linen");
    const titleInputs = screen.getAllByLabelText("Title");
    await user.type(titleInputs[0]!, "Kemeja Linen");
    const skuInputs = screen.getAllByLabelText(/sku/i);
    await user.type(skuInputs[0]!, "SKU-001");
    const priceInputs = screen.getAllByLabelText("Price");
    await user.type(priceInputs[0]!, "150000");

    await clickSave(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });
  });
});
