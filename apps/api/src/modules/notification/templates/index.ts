/**
 * Notification templates — pure renderers, no I/O.
 *
 * Each kind has a function that takes its typed payload + a locale and
 * returns `{ subject, body, htmlBody }`. The service hands the rendered
 * triple to the channel adapter; the channel does not know about kinds or
 * locales.
 *
 * Locale rules:
 *   - Default `id` (Bahasa Indonesia). The project is Bahasa-first per
 *     PRODUCT.md; merchants who ship to a multilingual market explicitly
 *     pass `locale: 'en'` for English bodies.
 *   - Unknown locales fall back to `id`. Callers should narrow at the
 *     boundary (`notificationLocaleSchema`); the renderer is defensive in
 *     case a future channel passes a string from a less-strict source.
 *
 * Voice (per the project's calm-copywriting policy):
 *   - Subject lines are direct: "Pesanan Anda telah diterima — #ORD-...".
 *     No promotional flourishes, no ALL-CAPS, no exclamation marks.
 *   - Bodies are functional. The customer wants to confirm the order
 *     details and find the next action; we hand them that, then stop.
 *   - HTML bodies mirror the plain-text body in structure, with minimal
 *     inline styles. The goal is legibility on mobile webmail clients,
 *     not visual identity.
 */
import {
  DEFAULT_NOTIFICATION_LOCALE,
  NOTIFICATION_LOCALES,
  type EmailVerificationPayload,
  type NotificationLocale,
  type NotificationMoney,
  type OrderConfirmationPayload,
  type PasswordResetPayload,
  type PaymentReceivedPayload,
  type ShippingUpdatePayload,
} from "../types.js";

export interface RenderedTemplate {
  subject: string;
  body: string;
  htmlBody: string;
}

/**
 * Resolve a locale to one of `NOTIFICATION_LOCALES`. Defensive against
 * unknown values — we fall back to `id` rather than throw because a
 * notification render path should not crash a request.
 */
function resolveLocale(locale: NotificationLocale | string | undefined): NotificationLocale {
  if (!locale) return DEFAULT_NOTIFICATION_LOCALE;
  return (NOTIFICATION_LOCALES as readonly string[]).includes(locale)
    ? (locale as NotificationLocale)
    : DEFAULT_NOTIFICATION_LOCALE;
}

/**
 * HTML-escape a string for inclusion in a `<p>` or attribute. Templates
 * interpolate user-supplied strings (recipient name, order ids, urls);
 * without escaping, an order id like `ord_<script>` would smuggle markup
 * into the rendered HTML body. Pure function, no DOM dependency.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Money formatter. `amount` is a decimal string in the smallest unit
 * (rupiah for IDR, since IDR has no minor unit). The format is
 * locale-aware:
 *   - `id`: "Rp 1.500.000"
 *   - `en`: "IDR 1,500,000"
 *
 * Other currencies print as "<CCY> <amount>" with the locale's grouping.
 * The renderer does not attempt full Intl.NumberFormat parity — bodies
 * just need to be readable on a phone, and the merchant has already set
 * the cart's currency upstream.
 */
function formatMoney(money: NotificationMoney, locale: NotificationLocale): string {
  const groupChar = locale === "id" ? "." : ",";
  const negative = money.amount.startsWith("-");
  const digits = negative ? money.amount.slice(1) : money.amount;
  // Group by threes from the right.
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, groupChar);
  const symbol = money.currency === "IDR" ? (locale === "id" ? "Rp" : "IDR") : money.currency;
  const sign = negative ? "-" : "";
  return `${sign}${symbol} ${grouped}`;
}

// ---------------------------------------------------------------------------
// email_verification
// ---------------------------------------------------------------------------

export function renderEmailVerification(
  payload: EmailVerificationPayload,
  localeInput?: NotificationLocale | string,
): RenderedTemplate {
  const locale = resolveLocale(localeInput);
  const greetingName = (payload.name ?? "").trim();
  const url = payload.url;

  if (locale === "en") {
    const subject = "Confirm your email address";
    const greeting = greetingName ? `Hello ${greetingName},` : "Hello,";
    const body = [
      greeting,
      "",
      "Please confirm your email address to finish setting up your account.",
      "",
      `Open this link: ${url}`,
      "",
      "If you did not request this, you can ignore this message.",
    ].join("\n");
    const htmlBody = wrapHtml(
      [
        `<p>${escapeHtml(greeting)}</p>`,
        `<p>Please confirm your email address to finish setting up your account.</p>`,
        `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
        `<p>If you did not request this, you can ignore this message.</p>`,
      ].join("\n"),
    );
    return { subject, body, htmlBody };
  }

  const subject = "Konfirmasi alamat email Anda";
  const greeting = greetingName ? `Halo ${greetingName},` : "Halo,";
  const body = [
    greeting,
    "",
    "Silakan konfirmasi alamat email Anda untuk menyelesaikan pendaftaran akun.",
    "",
    `Buka tautan berikut: ${url}`,
    "",
    "Jika Anda tidak meminta email ini, Anda dapat mengabaikannya.",
  ].join("\n");
  const htmlBody = wrapHtml(
    [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>Silakan konfirmasi alamat email Anda untuk menyelesaikan pendaftaran akun.</p>`,
      `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      `<p>Jika Anda tidak meminta email ini, Anda dapat mengabaikannya.</p>`,
    ].join("\n"),
  );
  return { subject, body, htmlBody };
}

// ---------------------------------------------------------------------------
// order_confirmation
// ---------------------------------------------------------------------------

export function renderOrderConfirmation(
  payload: OrderConfirmationPayload,
  localeInput?: NotificationLocale | string,
): RenderedTemplate {
  const locale = resolveLocale(localeInput);
  const orderId = payload.orderId;
  const items = payload.items;
  const totals = payload.totals;
  const shipping = payload.shippingAddress;

  if (locale === "en") {
    const subject = `Your order has been received — #${orderId}`;
    const lines: string[] = [
      "Thank you. We have received your order.",
      "",
      `Order: #${orderId}`,
      "",
      "Items:",
      ...items.map(
        (item) =>
          `  - ${item.name} x ${String(item.quantity)} — ${formatMoney(item.unitPrice, locale)}`,
      ),
      "",
      `Subtotal: ${formatMoney(totals.subtotal, locale)}`,
      `Tax: ${formatMoney(totals.tax, locale)}`,
      `Shipping: ${formatMoney(totals.shipping, locale)}`,
      `Total: ${formatMoney(totals.total, locale)}`,
      "",
      "Shipping address:",
      `  ${shipping.recipientName}`,
      `  ${shipping.phone}`,
      `  ${shipping.addressLine1}`,
      ...(shipping.addressLine2 ? [`  ${shipping.addressLine2}`] : []),
      `  ${shipping.city}, ${shipping.province} ${shipping.postalCode}`,
      "",
      "We will email you again once your order ships.",
    ];
    const body = lines.join("\n");
    const htmlBody = wrapHtml(orderConfirmationHtml(payload, locale));
    return { subject, body, htmlBody };
  }

  const subject = `Pesanan Anda telah diterima — #${orderId}`;
  const lines: string[] = [
    "Terima kasih. Pesanan Anda telah kami terima.",
    "",
    `Pesanan: #${orderId}`,
    "",
    "Daftar barang:",
    ...items.map(
      (item) =>
        `  - ${item.name} x ${String(item.quantity)} — ${formatMoney(item.unitPrice, locale)}`,
    ),
    "",
    `Subtotal: ${formatMoney(totals.subtotal, locale)}`,
    `Pajak: ${formatMoney(totals.tax, locale)}`,
    `Pengiriman: ${formatMoney(totals.shipping, locale)}`,
    `Total: ${formatMoney(totals.total, locale)}`,
    "",
    "Alamat pengiriman:",
    `  ${shipping.recipientName}`,
    `  ${shipping.phone}`,
    `  ${shipping.addressLine1}`,
    ...(shipping.addressLine2 ? [`  ${shipping.addressLine2}`] : []),
    `  ${shipping.city}, ${shipping.province} ${shipping.postalCode}`,
    "",
    "Kami akan mengirim email lanjutan ketika pesanan Anda diberangkatkan.",
  ];
  const body = lines.join("\n");
  const htmlBody = wrapHtml(orderConfirmationHtml(payload, locale));
  return { subject, body, htmlBody };
}

function orderConfirmationHtml(
  payload: OrderConfirmationPayload,
  locale: NotificationLocale,
): string {
  const id = locale === "en" ? "Order" : "Pesanan";
  const itemsLabel = locale === "en" ? "Items" : "Daftar barang";
  const subtotalLabel = locale === "en" ? "Subtotal" : "Subtotal";
  const taxLabel = locale === "en" ? "Tax" : "Pajak";
  const shippingLabel = locale === "en" ? "Shipping" : "Pengiriman";
  const totalLabel = locale === "en" ? "Total" : "Total";
  const addrLabel =
    locale === "en" ? "Shipping address" : "Alamat pengiriman";
  const opening =
    locale === "en"
      ? "Thank you. We have received your order."
      : "Terima kasih. Pesanan Anda telah kami terima.";
  const closing =
    locale === "en"
      ? "We will email you again once your order ships."
      : "Kami akan mengirim email lanjutan ketika pesanan Anda diberangkatkan.";

  const itemRows = payload.items
    .map(
      (item) =>
        `<li>${escapeHtml(item.name)} &times; ${String(item.quantity)} — ${escapeHtml(formatMoney(item.unitPrice, locale))}</li>`,
    )
    .join("\n");

  const a = payload.shippingAddress;
  const addressLines = [
    escapeHtml(a.recipientName),
    escapeHtml(a.phone),
    escapeHtml(a.addressLine1),
    ...(a.addressLine2 ? [escapeHtml(a.addressLine2)] : []),
    escapeHtml(`${a.city}, ${a.province} ${a.postalCode}`),
  ]
    .map((line) => `<div>${line}</div>`)
    .join("\n");

  return [
    `<p>${escapeHtml(opening)}</p>`,
    `<p><strong>${id}:</strong> #${escapeHtml(payload.orderId)}</p>`,
    `<p><strong>${itemsLabel}:</strong></p>`,
    `<ul>${itemRows}</ul>`,
    `<p>${subtotalLabel}: ${escapeHtml(formatMoney(payload.totals.subtotal, locale))}</p>`,
    `<p>${taxLabel}: ${escapeHtml(formatMoney(payload.totals.tax, locale))}</p>`,
    `<p>${shippingLabel}: ${escapeHtml(formatMoney(payload.totals.shipping, locale))}</p>`,
    `<p><strong>${totalLabel}: ${escapeHtml(formatMoney(payload.totals.total, locale))}</strong></p>`,
    `<p><strong>${addrLabel}:</strong></p>`,
    `<div>${addressLines}</div>`,
    `<p>${escapeHtml(closing)}</p>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// payment_received
// ---------------------------------------------------------------------------

export function renderPaymentReceived(
  payload: PaymentReceivedPayload,
  localeInput?: NotificationLocale | string,
): RenderedTemplate {
  const locale = resolveLocale(localeInput);

  if (locale === "en") {
    const subject = `Payment received — #${payload.orderId}`;
    const body = [
      "We have received your payment.",
      "",
      `Order: #${payload.orderId}`,
      `Amount: ${formatMoney(payload.amount, locale)}`,
      `Method: ${payload.paymentMethod}`,
      "",
      "We will start preparing your order.",
    ].join("\n");
    const htmlBody = wrapHtml(
      [
        `<p>We have received your payment.</p>`,
        `<p><strong>Order:</strong> #${escapeHtml(payload.orderId)}</p>`,
        `<p><strong>Amount:</strong> ${escapeHtml(formatMoney(payload.amount, locale))}</p>`,
        `<p><strong>Method:</strong> ${escapeHtml(payload.paymentMethod)}</p>`,
        `<p>We will start preparing your order.</p>`,
      ].join("\n"),
    );
    return { subject, body, htmlBody };
  }

  const subject = `Pembayaran diterima — #${payload.orderId}`;
  const body = [
    "Kami telah menerima pembayaran Anda.",
    "",
    `Pesanan: #${payload.orderId}`,
    `Jumlah: ${formatMoney(payload.amount, locale)}`,
    `Metode: ${payload.paymentMethod}`,
    "",
    "Kami akan segera memproses pesanan Anda.",
  ].join("\n");
  const htmlBody = wrapHtml(
    [
      `<p>Kami telah menerima pembayaran Anda.</p>`,
      `<p><strong>Pesanan:</strong> #${escapeHtml(payload.orderId)}</p>`,
      `<p><strong>Jumlah:</strong> ${escapeHtml(formatMoney(payload.amount, locale))}</p>`,
      `<p><strong>Metode:</strong> ${escapeHtml(payload.paymentMethod)}</p>`,
      `<p>Kami akan segera memproses pesanan Anda.</p>`,
    ].join("\n"),
  );
  return { subject, body, htmlBody };
}

// ---------------------------------------------------------------------------
// shipping_update
// ---------------------------------------------------------------------------

export function renderShippingUpdate(
  payload: ShippingUpdatePayload,
  localeInput?: NotificationLocale | string,
): RenderedTemplate {
  const locale = resolveLocale(localeInput);

  if (locale === "en") {
    const subject = `Shipping update — #${payload.orderId}`;
    const body = [
      "There is an update on your shipment.",
      "",
      `Order: #${payload.orderId}`,
      `Status: ${payload.status}`,
      ...(payload.trackingCode ? [`Tracking: ${payload.trackingCode}`] : []),
      ...(payload.estimatedDelivery
        ? [`Estimated delivery: ${payload.estimatedDelivery}`]
        : []),
    ].join("\n");
    const htmlBody = wrapHtml(
      [
        `<p>There is an update on your shipment.</p>`,
        `<p><strong>Order:</strong> #${escapeHtml(payload.orderId)}</p>`,
        `<p><strong>Status:</strong> ${escapeHtml(payload.status)}</p>`,
        ...(payload.trackingCode
          ? [
              `<p><strong>Tracking:</strong> ${escapeHtml(payload.trackingCode)}</p>`,
            ]
          : []),
        ...(payload.estimatedDelivery
          ? [
              `<p><strong>Estimated delivery:</strong> ${escapeHtml(payload.estimatedDelivery)}</p>`,
            ]
          : []),
      ].join("\n"),
    );
    return { subject, body, htmlBody };
  }

  const subject = `Pembaruan pengiriman — #${payload.orderId}`;
  const body = [
    "Ada pembaruan pengiriman untuk pesanan Anda.",
    "",
    `Pesanan: #${payload.orderId}`,
    `Status: ${payload.status}`,
    ...(payload.trackingCode ? [`Resi: ${payload.trackingCode}`] : []),
    ...(payload.estimatedDelivery
      ? [`Perkiraan tiba: ${payload.estimatedDelivery}`]
      : []),
  ].join("\n");
  const htmlBody = wrapHtml(
    [
      `<p>Ada pembaruan pengiriman untuk pesanan Anda.</p>`,
      `<p><strong>Pesanan:</strong> #${escapeHtml(payload.orderId)}</p>`,
      `<p><strong>Status:</strong> ${escapeHtml(payload.status)}</p>`,
      ...(payload.trackingCode
        ? [`<p><strong>Resi:</strong> ${escapeHtml(payload.trackingCode)}</p>`]
        : []),
      ...(payload.estimatedDelivery
        ? [
            `<p><strong>Perkiraan tiba:</strong> ${escapeHtml(payload.estimatedDelivery)}</p>`,
          ]
        : []),
    ].join("\n"),
  );
  return { subject, body, htmlBody };
}

// ---------------------------------------------------------------------------
// password_reset
// ---------------------------------------------------------------------------

export function renderPasswordReset(
  payload: PasswordResetPayload,
  localeInput?: NotificationLocale | string,
): RenderedTemplate {
  const locale = resolveLocale(localeInput);
  const greetingName = (payload.name ?? "").trim();

  if (locale === "en") {
    const subject = "Reset your password";
    const greeting = greetingName ? `Hello ${greetingName},` : "Hello,";
    const body = [
      greeting,
      "",
      "Use the link below to reset your password.",
      "",
      `Open this link: ${payload.url}`,
      "",
      "If you did not request a reset, you can ignore this message.",
    ].join("\n");
    const htmlBody = wrapHtml(
      [
        `<p>${escapeHtml(greeting)}</p>`,
        `<p>Use the link below to reset your password.</p>`,
        `<p><a href="${escapeHtml(payload.url)}">${escapeHtml(payload.url)}</a></p>`,
        `<p>If you did not request a reset, you can ignore this message.</p>`,
      ].join("\n"),
    );
    return { subject, body, htmlBody };
  }

  const subject = "Atur ulang kata sandi Anda";
  const greeting = greetingName ? `Halo ${greetingName},` : "Halo,";
  const body = [
    greeting,
    "",
    "Gunakan tautan berikut untuk mengatur ulang kata sandi Anda.",
    "",
    `Buka tautan berikut: ${payload.url}`,
    "",
    "Jika Anda tidak meminta perubahan kata sandi, Anda dapat mengabaikannya.",
  ].join("\n");
  const htmlBody = wrapHtml(
    [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>Gunakan tautan berikut untuk mengatur ulang kata sandi Anda.</p>`,
      `<p><a href="${escapeHtml(payload.url)}">${escapeHtml(payload.url)}</a></p>`,
      `<p>Jika Anda tidak meminta perubahan kata sandi, Anda dapat mengabaikannya.</p>`,
    ].join("\n"),
  );
  return { subject, body, htmlBody };
}

// ---------------------------------------------------------------------------
// HTML wrapper
// ---------------------------------------------------------------------------

/**
 * Minimal HTML envelope. Inline styles only — most webmail clients strip
 * `<style>` tags, and our copy is functional enough that a styled body
 * adds little. The wrapper keeps a `font-family: sans-serif` so messages
 * read consistently across mobile webmail.
 */
function wrapHtml(inner: string): string {
  return [
    `<!doctype html>`,
    `<html><body style="font-family: sans-serif; line-height: 1.5;">`,
    inner,
    `</body></html>`,
  ].join("\n");
}
