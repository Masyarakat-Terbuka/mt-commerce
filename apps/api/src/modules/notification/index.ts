/**
 * Notification module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing
 * layer import only what this file re-exports. The auth module reaches
 * for `notificationService.send(...)` from here. Plugin authors who add a
 * new channel implement the `NotificationChannel` interface from here.
 *
 * Public surface:
 *   - The `NotificationChannel` interface (channels/types.ts) — channel
 *     authors implement this to add new transports.
 *   - Domain types: `Notification`, `NotificationKind`,
 *     `NotificationChannelId`, `NotificationStatus`, `Paginated<T>`,
 *     and the per-kind payload types.
 *   - The `NotificationService` interface and a default `notificationService`
 *     accessor wired to the runtime database and SMTP/console channels.
 *   - `wire.ts:buildAdminRoutes()` — the audit-log admin router, ready to
 *     mount. Imported from `wire.ts` rather than this index to keep the
 *     auth ↔ notification dependency graph acyclic at module-evaluation.
 *   - Pure renderers from `templates/index.ts` for callers who want to
 *     render without sending (rare; most callers use `service.send`).
 */
import { getNotificationService } from "./service.js";

export type { NotificationChannel, ChannelSendInput } from "./channels/types.js";
export { ConsoleEmailChannel } from "./channels/console.js";
export { SmtpEmailChannel, createEmailChannel } from "./channels/smtp.js";
export { WhatsappStubChannel } from "./channels/whatsapp-stub.js";

export type {
  EmailVerificationPayload,
  ListNotificationsQuery,
  Notification,
  NotificationAddress,
  NotificationChannelId,
  NotificationKind,
  NotificationLineItem,
  NotificationLocale,
  NotificationMoney,
  NotificationPayload,
  NotificationResult,
  NotificationStatus,
  NotificationTotals,
  OrderConfirmationPayload,
  Paginated,
  PasswordResetPayload,
  PaymentReceivedPayload,
  ShippingUpdatePayload,
  SendInput,
} from "./types.js";

export {
  DEFAULT_NOTIFICATION_LOCALE,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_LOCALES,
  NOTIFICATION_STATUSES,
} from "./types.js";

export type {
  NotificationService,
  NotificationServiceOptions,
} from "./service.js";

export {
  NotificationServiceImpl,
  __setNotificationServiceForTesting,
  getNotificationService,
} from "./service.js";

export {
  renderEmailVerification,
  renderOrderConfirmation,
  renderPasswordReset,
  renderPaymentReceived,
  renderShippingUpdate,
} from "./templates/index.js";

export type { RenderedTemplate } from "./templates/index.js";

export type { NotificationRepository } from "./repository.js";
export { createNotificationRepository } from "./repository.js";

/**
 * Default singleton accessor for cross-module callers (e.g. auth's
 * `sendVerificationEmail`). Lazy so tests that never touch this module
 * do not pay the SMTP factory's production-mode boot throw.
 */
export function notificationService() {
  return getNotificationService();
}

// NOTE: `buildNotificationAdminRoutes` (and the pre-built `adminRoutes`
// singleton) live in `./wire.ts`, NOT here. Importing the route file
// from this module's public index would pull in `auth/index.js` for the
// route guards, and the auth module reaches back into THIS file to
// resolve `getNotificationService` for `sendVerificationEmail` — a
// circular import. Callers that need the router import from
// `./wire.js` directly (`buildAdminRoutes()`).
