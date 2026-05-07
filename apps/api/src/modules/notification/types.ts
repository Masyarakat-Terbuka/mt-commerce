/**
 * Notification module — domain types and Zod schemas.
 *
 * Two layers, mirroring the other modules:
 *
 *   1. Domain types (`Notification`, `NotificationKind`, `NotificationChannelId`,
 *      `NotificationStatus`, `Paginated<T>`) — clean shapes the rest of the
 *      system consumes. Dates are `Date` instances; the route layer converts
 *      to ISO strings on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation and template payload typing.
 *      The audit-log read endpoint is the only HTTP surface in v0.1; everything
 *      else (sends) happens via service calls or event listeners.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Channels and kinds
// ---------------------------------------------------------------------------

/**
 * Channels we can route a notification through. Adding `sms` later goes here
 * first, then in the channel registry. WhatsApp ships as a stub in v0.1
 * because the real plugin lands later.
 */
export const NOTIFICATION_CHANNELS = ["email", "whatsapp"] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Templated message kinds. Each kind has a corresponding renderer in
 * `templates/index.ts`. New kinds: add the literal here, add a `payload`
 * type below, register a renderer, write a test.
 */
export const NOTIFICATION_KINDS = [
  "email_verification",
  "order_confirmation",
  "payment_received",
  "shipping_update",
  "password_reset",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ["pending", "sent", "failed"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Per-kind payload types
// ---------------------------------------------------------------------------

/**
 * Indonesian / English locale tag. Default `id` per project policy
 * (Bahasa-first). The notification module duplicates the locale union here
 * rather than reaching into the catalog module's `i18n.ts` so the contract
 * remains module-local — templates fall back to `id` on any unknown tag.
 */
export const NOTIFICATION_LOCALES = ["id", "en"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];
export const DEFAULT_NOTIFICATION_LOCALE: NotificationLocale = "id";

/**
 * Money-on-the-wire shape: amount as a decimal string (preserves bigint
 * precision through JSON), currency as ISO 4217. Templates render this
 * with `formatRupiah`-style helpers that honor the currency.
 */
export interface NotificationMoney {
  amount: string;
  currency: string;
}

export interface NotificationLineItem {
  name: string;
  quantity: number;
  unitPrice: NotificationMoney;
}

export interface NotificationAddress {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  province: string;
  postalCode: string;
}

export interface NotificationTotals {
  subtotal: NotificationMoney;
  tax: NotificationMoney;
  shipping: NotificationMoney;
  total: NotificationMoney;
}

export interface EmailVerificationPayload {
  url: string;
  name?: string | null;
}

export interface OrderConfirmationPayload {
  orderId: string;
  items: NotificationLineItem[];
  totals: NotificationTotals;
  shippingAddress: NotificationAddress;
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
  /** Optional ISO 8601 date for the carrier's stated ETA. */
  estimatedDelivery?: string | null;
}

export interface PasswordResetPayload {
  url: string;
  name?: string | null;
}

/**
 * Discriminated union of every kind + its payload. The service narrows on
 * `kind` before handing the payload to the renderer, so a future kind that
 * forgets to add a renderer fails the type check at the dispatch point.
 */
export type NotificationPayload =
  | { kind: "email_verification"; payload: EmailVerificationPayload }
  | { kind: "order_confirmation"; payload: OrderConfirmationPayload }
  | { kind: "payment_received"; payload: PaymentReceivedPayload }
  | { kind: "shipping_update"; payload: ShippingUpdatePayload }
  | { kind: "password_reset"; payload: PasswordResetPayload };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  channel: NotificationChannelId;
  kind: NotificationKind;
  recipient: string;
  subject: string | null;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NotificationResult {
  notification: Notification;
}

/**
 * Input shape for the service's `send` and `sendOrThrow`. Re-exported here
 * (declared in `service.ts`) for callers who want to type a builder/wrapper
 * around the service without importing from the impl file.
 */
export interface SendInput {
  channel?: NotificationChannelId;
  recipient: string;
  message: NotificationPayload;
  locale?: NotificationLocale;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export const notificationLocaleSchema = z.enum(NOTIFICATION_LOCALES);

// ---------------------------------------------------------------------------
// Admin list query
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listNotificationsQuerySchema = z.object({
  channel: notificationChannelSchema.optional(),
  kind: notificationKindSchema.optional(),
  status: notificationStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
