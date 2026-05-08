/**
 * Payments module — public contract.
 *
 * Per ADR-0005 (modular monolith), other modules and the HTTP routing
 * layer import only what this file re-exports. Anything not surfaced
 * here is an implementation detail and not safe for cross-module use.
 *
 * Public surface:
 *   - Domain types (`Payment`, `PaymentAttempt`, `PaymentStatus`,
 *     `PaymentInitiateOutcome`, `Paginated<T>`).
 *   - The `PaymentService` interface and a default `paymentService`
 *     singleton wired to the runtime database, the live order service,
 *     and the default provider registry.
 *   - State-machine helpers (`canTransition`, `isTerminal`,
 *     `ALL_PAYMENT_STATUSES`) — pure, no I/O.
 *   - Route builders + pre-built singletons.
 *   - The `PaymentProvider` interface + the registry surface so
 *     plugins can register new providers without reaching into the
 *     module's internals.
 *   - The typed event bus (`events`) and event payload map.
 *   - The in-memory test provider — exported so integration tests can
 *     observe its state and sign webhook fixtures.
 */
import { buildPaymentsAdminRoutes } from "./routes/admin.js";
import { buildPaymentsStorefrontRoutes } from "./routes/storefront.js";
import { buildPaymentsWebhookRoutes } from "./routes/webhook.js";
import { paymentService } from "./service.js";

// Domain types
export type {
  CapturePaymentInput as CapturePaymentInputSchemaType,
  InitiatePaymentInput as InitiatePaymentInputSchemaType,
  ListPaymentsQuery,
  Paginated,
  Payment,
  PaymentAttempt,
  PaymentAttemptKind,
  PaymentAttemptStatus,
  PaymentInitiateOutcome,
  PaymentStatus,
  PaymentWithAttempts,
  RefundPaymentInput as RefundPaymentInputSchemaType,
} from "./types.js";

// Service
export type {
  CapturePaymentInput,
  HandleWebhookInput,
  HandleWebhookResult,
  InitiatePaymentInput,
  PaymentService,
  RefundPaymentInput,
} from "./service.js";
export { PaymentServiceImpl, paymentService } from "./service.js";

// State helpers
export {
  ALL_PAYMENT_ATTEMPT_KINDS,
  ALL_PAYMENT_ATTEMPT_STATUSES,
  ALL_PAYMENT_STATUSES,
  canTransition,
  isTerminal,
} from "./state.js";

// Provider seam
export type {
  CaptureInput,
  CaptureResult,
  InitiateInput,
  InitiateResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "./providers/types.js";

export {
  createInMemoryTestPaymentProvider,
  IN_MEMORY_TEST_PROVIDER_CODE,
  signTestWebhook,
} from "./providers/in-memory.js";
export type {
  InMemoryTestPaymentProvider,
  InMemoryTestProviderOptions,
} from "./providers/in-memory.js";

export {
  createPaymentProviderRegistry,
  paymentProviderRegistry,
} from "./providers/registry.js";
export type { PaymentProviderRegistry } from "./providers/registry.js";

// Events
export { events } from "./events.js";
export type { EventName, EventPayload, PaymentEventMap } from "./events.js";

// Routes
export {
  buildPaymentsAdminRoutes,
  buildPaymentsStorefrontRoutes,
  buildPaymentsWebhookRoutes,
};

export const adminRoutes = buildPaymentsAdminRoutes(paymentService);
export const storefrontRoutes = buildPaymentsStorefrontRoutes(paymentService);
export const webhookRoutes = buildPaymentsWebhookRoutes(paymentService);
