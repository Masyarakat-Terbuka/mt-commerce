/**
 * Template renderers — verify each kind renders both `id` and `en`
 * variants with the expected subject and body lines. Pure-function
 * tests; no I/O, no service.
 */
import { describe, expect, it } from "vitest";
import {
  renderEmailVerification,
  renderOrderConfirmation,
  renderPasswordReset,
  renderPaymentReceived,
  renderShippingUpdate,
} from "../../../src/modules/notification/templates/index.js";

describe("renderEmailVerification", () => {
  it("renders Bahasa subject and body by default", () => {
    const out = renderEmailVerification({
      url: "https://example.com/verify/x",
      name: "Budi",
    });
    expect(out.subject).toBe("Konfirmasi alamat email Anda");
    expect(out.body).toContain("Halo Budi,");
    expect(out.body).toContain("Silakan konfirmasi");
    expect(out.body).toContain("https://example.com/verify/x");
    expect(out.htmlBody).toContain("<a href=\"https://example.com/verify/x\">");
  });

  it("renders English subject and body when locale='en'", () => {
    const out = renderEmailVerification(
      { url: "https://example.com/verify/x", name: "Budi" },
      "en",
    );
    expect(out.subject).toBe("Confirm your email address");
    expect(out.body).toContain("Hello Budi,");
    expect(out.body).toContain("Please confirm your email address");
  });

  it("falls back to a generic greeting when name is empty", () => {
    const out = renderEmailVerification({ url: "https://x", name: "" });
    expect(out.body).toContain("Halo,");
    expect(out.body).not.toContain("Halo ,");
  });

  it("escapes HTML metacharacters in the URL", () => {
    const out = renderEmailVerification({
      url: "https://x/?q=<script>",
      name: "Budi",
    });
    expect(out.htmlBody).toContain("&lt;script&gt;");
    expect(out.htmlBody).not.toContain("<script>");
  });
});

describe("renderOrderConfirmation", () => {
  const payload = {
    orderId: "ord_01",
    items: [
      {
        name: "Kemeja Putih",
        quantity: 2,
        unitPrice: { amount: "150000", currency: "IDR" },
      },
    ],
    totals: {
      subtotal: { amount: "300000", currency: "IDR" },
      tax: { amount: "33000", currency: "IDR" },
      shipping: { amount: "20000", currency: "IDR" },
      total: { amount: "353000", currency: "IDR" },
    },
    shippingAddress: {
      recipientName: "Budi",
      phone: "+628123456789",
      addressLine1: "Jl. Sudirman 1",
      addressLine2: null,
      city: "Jakarta",
      province: "DKI Jakarta",
      postalCode: "12190",
    },
  };

  it("renders Bahasa subject anchored on the order id", () => {
    const out = renderOrderConfirmation(payload);
    expect(out.subject).toBe("Pesanan Anda telah diterima — #ord_01");
    expect(out.body).toContain("Terima kasih");
    expect(out.body).toContain("Pesanan: #ord_01");
    expect(out.body).toContain("Kemeja Putih x 2");
    // IDR formatted with `id` locale grouping (`.`).
    expect(out.body).toContain("Rp 150.000");
    expect(out.body).toContain("Rp 353.000");
    expect(out.body).toContain("Jl. Sudirman 1");
  });

  it("renders English subject anchored on the order id", () => {
    const out = renderOrderConfirmation(payload, "en");
    expect(out.subject).toBe("Your order has been received — #ord_01");
    expect(out.body).toContain("Thank you");
    expect(out.body).toContain("Order: #ord_01");
    // IDR formatted with `en` locale grouping (`,`).
    expect(out.body).toContain("IDR 150,000");
  });
});

describe("renderPaymentReceived", () => {
  const payload = {
    orderId: "ord_01",
    amount: { amount: "353000", currency: "IDR" },
    paymentMethod: "QRIS",
  };

  it("renders Bahasa subject and method", () => {
    const out = renderPaymentReceived(payload);
    expect(out.subject).toBe("Pembayaran diterima — #ord_01");
    expect(out.body).toContain("Rp 353.000");
    expect(out.body).toContain("Metode: QRIS");
  });

  it("renders English subject and method", () => {
    const out = renderPaymentReceived(payload, "en");
    expect(out.subject).toBe("Payment received — #ord_01");
    expect(out.body).toContain("Method: QRIS");
  });
});

describe("renderShippingUpdate", () => {
  it("renders Bahasa with tracking when present", () => {
    const out = renderShippingUpdate({
      orderId: "ord_01",
      status: "shipped",
      trackingCode: "JNE-12345",
    });
    expect(out.subject).toBe("Pembaruan pengiriman — #ord_01");
    expect(out.body).toContain("Status: shipped");
    expect(out.body).toContain("Resi: JNE-12345");
  });

  it("omits tracking line when not provided", () => {
    const out = renderShippingUpdate({
      orderId: "ord_01",
      status: "preparing",
      trackingCode: null,
    });
    expect(out.body).not.toContain("Resi:");
  });

  it("renders English variant", () => {
    const out = renderShippingUpdate(
      { orderId: "ord_01", status: "shipped", trackingCode: "JNE-1" },
      "en",
    );
    expect(out.subject).toBe("Shipping update — #ord_01");
    expect(out.body).toContain("Tracking: JNE-1");
  });
});

describe("renderPasswordReset", () => {
  it("renders Bahasa by default with the URL", () => {
    const out = renderPasswordReset({ url: "https://x/reset/abc", name: "Sari" });
    expect(out.subject).toBe("Atur ulang kata sandi Anda");
    expect(out.body).toContain("Halo Sari,");
    expect(out.body).toContain("https://x/reset/abc");
  });

  it("renders English variant", () => {
    const out = renderPasswordReset(
      { url: "https://x/reset/abc", name: "Sari" },
      "en",
    );
    expect(out.subject).toBe("Reset your password");
    expect(out.body).toContain("Hello Sari,");
  });
});

describe("locale fallback", () => {
  it("falls back to Bahasa when locale is unknown", () => {
    const out = renderEmailVerification(
      { url: "https://x", name: "Budi" },
      "fr" as unknown as "id",
    );
    expect(out.subject).toBe("Konfirmasi alamat email Anda");
  });
});
