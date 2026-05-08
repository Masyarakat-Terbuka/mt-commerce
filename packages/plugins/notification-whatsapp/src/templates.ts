/**
 * Template payload → WhatsApp template variable mapping.
 *
 * Each function takes the structured payload the notification service
 * hands us (the same shape as the in-tree
 * `apps/api/src/modules/notification/types.ts` payload types — duplicated
 * structurally here so the plugin does not import from the api package)
 * and returns the WhatsApp `components` array Meta expects on a
 * `type: "template"` message.
 *
 * Why one function per kind, kept tiny:
 *   - WhatsApp Business templates are operator-approved upstream. The
 *     template's variable LIST and ORDER are decided in the Meta dashboard
 *     and frozen the moment Meta approves the template. We mirror that
 *     order here and document it in the README — changing it requires a
 *     resubmission, not a code edit.
 *   - Each mapping is a pure function of `(payload, locale)`. No I/O, no
 *     branching beyond the locale label, no formatting beyond the bare
 *     minimum required to satisfy WhatsApp's "no newlines, no tabs, no
 *     more than 4 consecutive spaces" rule for body parameters.
 *
 * Variable order per kind (positional in the BODY component):
 *
 *   `order_confirmation`
 *     {{1}} order id (orderNumber, e.g. `MT-2025-000123`)
 *     {{2}} formatted total (e.g. `Rp 1.500.000`)
 *     {{3}} item count (e.g. `3 barang`)
 *
 *   `payment_received`
 *     {{1}} order id
 *     {{2}} formatted amount
 *     {{3}} payment method label
 *
 *   `shipping_update`
 *     {{1}} order id
 *     {{2}} status label (`shipped` / `Dikirim`)
 *     {{3}} tracking code (or "-" when null)
 */

import type { WhatsappLocale } from "./locale.js";

// ---------------------------------------------------------------------------
// Structural payload types — mirror the api's notification payload shapes
// so the plugin does not need to import from `@mt-commerce/api`. The api
// emits exactly these shapes through `NotificationChannelSendInput.payload`.
// ---------------------------------------------------------------------------

export interface NotificationMoney {
  amount: string;
  currency: string;
}

export interface NotificationLineItem {
  name: string;
  quantity: number;
  unitPrice: NotificationMoney;
}

export interface NotificationTotals {
  subtotal: NotificationMoney;
  tax: NotificationMoney;
  shipping: NotificationMoney;
  total: NotificationMoney;
}

export interface OrderConfirmationPayload {
  orderId: string;
  items: NotificationLineItem[];
  totals: NotificationTotals;
  // shippingAddress is rendered into the email body; WhatsApp's
  // approved template body has a 1024-char limit and we keep variables
  // tight, so the address is not surfaced via WhatsApp in v0.1.
}

export interface PaymentReceivedPayload {
  orderId: string;
  amount: NotificationMoney;
  paymentMethod: string;
}

export interface ShippingUpdatePayload {
  orderId: string;
  trackingCode: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Wire-shape types for the WhatsApp Cloud API request body. Documented at
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
// We only use the BODY component with positional text parameters in v0.1.
// ---------------------------------------------------------------------------

export interface WhatsappTemplateParameter {
  type: "text";
  text: string;
}

export interface WhatsappTemplateComponent {
  type: "body";
  parameters: WhatsappTemplateParameter[];
}

// ---------------------------------------------------------------------------
// Helpers — formatting kept module-local because the api's template
// renderer already produced human-readable strings into the email body,
// but those are NOT what we hand WhatsApp (Meta enforces parameter
// hygiene rules that reject newlines/tabs).
// ---------------------------------------------------------------------------

/**
 * Format `NotificationMoney` for a WhatsApp body parameter. Locale-aware
 * grouping but stripped of newlines/tabs. The currency rendering matches
 * the email template's voice (`Rp 1.500.000` for `id-IDR`).
 */
export function formatMoney(money: NotificationMoney, locale: WhatsappLocale): string {
  const groupChar = locale === "id" ? "." : ",";
  const negative = money.amount.startsWith("-");
  const digits = negative ? money.amount.slice(1) : money.amount;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, groupChar);
  const symbol = money.currency === "IDR" ? (locale === "id" ? "Rp" : "IDR") : money.currency;
  const sign = negative ? "-" : "";
  return `${sign}${symbol} ${grouped}`;
}

/**
 * Sanitise a body parameter value for the Meta API. Meta rejects:
 *   - tabs
 *   - newlines (any kind)
 *   - 4+ consecutive spaces
 *
 * Empty values are coerced to `"-"` because WhatsApp rejects empty
 * positional parameters with `132000 (number of parameters does not
 * match)`. Trim and collapse whitespace so a multi-line address never
 * sneaks into a body variable.
 */
export function sanitizeParam(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? "-" : collapsed;
}

function param(text: string): WhatsappTemplateParameter {
  return { type: "text", text: sanitizeParam(text) };
}

function bodyComponent(values: string[]): WhatsappTemplateComponent[] {
  return [
    {
      type: "body",
      parameters: values.map(param),
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-kind mappers
// ---------------------------------------------------------------------------

export function buildOrderConfirmationComponents(
  payload: OrderConfirmationPayload,
  locale: WhatsappLocale,
): WhatsappTemplateComponent[] {
  // Item count is rendered as "3 barang" / "3 items" — the WhatsApp body
  // is a one-glance summary; the email already carries the full line
  // breakdown.
  const itemCount = payload.items.reduce(
    (sum, line) => sum + (Number.isFinite(line.quantity) ? line.quantity : 0),
    0,
  );
  const itemLabel = locale === "id" ? `${itemCount} barang` : `${itemCount} item${itemCount === 1 ? "" : "s"}`;

  return bodyComponent([
    payload.orderId,
    formatMoney(payload.totals.total, locale),
    itemLabel,
  ]);
}

export function buildPaymentReceivedComponents(
  payload: PaymentReceivedPayload,
  locale: WhatsappLocale,
): WhatsappTemplateComponent[] {
  return bodyComponent([
    payload.orderId,
    formatMoney(payload.amount, locale),
    payload.paymentMethod,
  ]);
}

export function buildShippingUpdateComponents(
  payload: ShippingUpdatePayload,
  locale: WhatsappLocale,
): WhatsappTemplateComponent[] {
  // The fulfillment lifecycle today only fires on `shipped`; we keep the
  // status string here so a future "delivered" / "out_for_delivery"
  // transition lands without a mapper change. Localise the wire status
  // for the customer-facing template body.
  const statusLabel = localiseStatus(payload.status, locale);
  const tracking = payload.trackingCode ?? "-";
  return bodyComponent([payload.orderId, statusLabel, tracking]);
}

function localiseStatus(status: string, locale: WhatsappLocale): string {
  if (locale === "en") {
    switch (status) {
      case "shipped":
        return "Shipped";
      case "delivered":
        return "Delivered";
      default:
        return status;
    }
  }
  switch (status) {
    case "shipped":
      return "Dikirim";
    case "delivered":
      return "Diterima";
    default:
      return status;
  }
}
