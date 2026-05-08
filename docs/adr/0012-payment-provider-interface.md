# ADR-0012: PaymentProvider interface and the registry bridge

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce supports multiple payment providers (Midtrans and Xendit are the obvious Indonesian targets; Stripe and a manual offline-transfer flow are equally plausible). The platform itself does not bundle them — per [ADR-0008](./0008-plugins-as-npm-packages.md), payment providers are plugin packages.

That commitment leaves a number of shape decisions:

- What is the exact method surface a provider must implement?
- Where does the registry of installed providers live — in `@mt-commerce/core` (so plugins can see it) or in the api's payments module (so the service can use it)?
- What is the seam between the plugin-facing contract (which must not depend on api types) and the service-facing contract (which is shaped by what the payments service needs to do its job)?
- How does idempotency get enforced — at the HTTP layer, at the database, or both?

The Indonesian payments landscape is varied enough that a contract designed for one provider tends to creak under another. Midtrans Snap is redirect-driven; some Xendit channels capture synchronously; offline-transfer flows are pending until an operator confirms. The contract must accept all of these without growing a flag per provider.

---

## Decision

A `PaymentProvider` interface defines four lifecycle methods:

- `initiate(input)` — begin a charge. Returns one of three discriminated outcomes: `redirect` (send the buyer to a hosted page), `captured` (settled synchronously), or `pending` (in-flight, no URL).
- `capture(input)` — settle an authorised payment. A no-op for capture-on-initiate providers; the service still records an attempt row for audit parity.
- `refund(input)` — full or partial refund.
- `verifyWebhookSignature(input)` — synchronous, throws on failure, returns the canonical `(event, providerRef, status, rawPayload)` projection so the dispatcher does not branch per provider.

The provider registry lives in the **payments module** (`apps/api/src/modules/payments/providers/registry.ts`), not in `@mt-commerce/core`. The plugin-facing contract lives in `@mt-commerce/core/plugin` (so plugins compile against it without reaching into the api). An adapter (`plugin-adapter.ts`) bridges the two.

Idempotency layers in two places: an HTTP middleware (`Idempotency-Key` header) and a unique `idempotency_key` column on the `payments` row.

---

## Consequences

### Positive

The four-method surface is the smallest set that supports every flow we know about. `initiate`'s discriminated outcome is what makes the contract honest — a Snap-style hosted-page provider, a synchronous-capture provider, and an offline-transfer provider all return the *same* shape, and the service handles them with the same dispatch logic. There are no provider-specific branches in `payments/service.ts`.

The registry's location matches the bounded context. Providers are payments-module domain objects: their lifetime is the api process, the service is their only caller, and the row data they read belongs to the payments module. Putting the registry in `@mt-commerce/core` would have made it a shared mutable singleton, which would force the auth/notification/shipping modules to accept a transitive dependency on something they never use. Keeping it module-local respects [ADR-0005](./0005-modular-monolith.md): each module owns the registries it consumes.

The plugin-facing `PaymentProvider` (in core) and the service-facing `PaymentProvider` (in the payments module) are *intentionally* different interfaces. The plugin contract returns `{ providerTransactionId, redirectUrl?, ... }` and a `boolean` from `verifyWebhookSignature` — that is what plugin authors compile against. The service contract returns the discriminated `InitiateResult` and the canonical `VerifiedWebhook` tuple. The adapter does the projection. Plugins cannot accidentally depend on api types; the service cannot leak provider-specific shapes into business logic.

The registry rejects re-registration with the same `code`. Two plugins claiming `"midtrans"` is a configuration error the operator should see at boot, not as a wrong-provider call mid-checkout.

Idempotency layers cleanly. The HTTP middleware catches "client retried the request because the network blipped" — same key, same body, returns the cached response. The `idempotency_key` column on `payments` catches "client retried with a fresh request id but the same business intent" — the unique constraint rejects, the service rehydrates the existing row, and the upstream provider is not called twice. The two layers solve different races, and either alone is insufficient.

### Negative

The two-registry bridge is real complexity. A plugin author writing a provider must understand that their `verifyWebhookSignature` returns `boolean` while the service expects a structured tuple — the adapter handles the lift, but the gap exists. We accept this in exchange for keeping plugins decoupled from api types.

The synchronous-only `verifyWebhookSignature` rules out async signature schemes (e.g. fetching a per-event public key from the provider). A plugin that needs async verification must own its own webhook route handler and call into `paymentService.handleWebhook` directly. v0.1 ships no provider with this need.

Partial refunds are recorded on the attempt's `requestPayload`, not as their own row. A `captured → refunded` transition collapses any partial amount into the parent row's status. A future iteration can model partial refunds as their own attempt rows, but v0.1's payments admin grid does not need that detail.

`initiate` returning `captured` triggers two transactions: the payment row writes first, then the order transitions `pending_payment → paid` after that commit. The split is deliberate (a long-running provider HTTP call must not pin a Postgres connection), but it means an order can briefly be `pending_payment` while its payment is `captured`. The reconciliation is in the service and the admin views handle the in-between state.

---

## Alternatives considered

### Single shared registry in `@mt-commerce/core`

Putting the registry in core would let plugins call `paymentProviderRegistry.register(...)` directly without going through `PluginContext`. It was rejected because:

- It would make core a place where mutable singletons live, which is the opposite of what core is for (pure types, helpers, and the plugin contract).
- Modules other than payments would still have to import from core to interact with it, breaking the bounded-context rule.
- The plugin-loader path already provides a clean injection point (`ctx.registerPaymentProvider(...)`) so plugins do not need direct registry access.

### Single unified `PaymentProvider` interface across plugin + service

A single interface — used by plugins to compile against and by the service to consume — would eliminate the adapter. It was rejected because:

- The plugin contract should not change shape every time the service grows a new internal need. Today the service consumes `VerifiedWebhook` with a canonical projection; tomorrow it might want a structured `RefundResult` with partial-refund metadata. A unified interface would force a plugin recompile on every internal change.
- The plugin contract should be minimal and stable; the service contract is shaped by what `payments/service.ts` actually does. These pull in different directions.
- The adapter is small (one file) and the cost of having it is paid once. The cost of not having it is paid forever, by every plugin author.

### Idempotency at the HTTP layer only

Relying on the `Idempotency-Key` middleware alone would be enough for the network-retry case, but it would not catch the case where a client mints a fresh request id for what is logically the same business intent (a checkout-flow client that regenerates the header on every render). The unique column on `payments` is the second backstop — the database is the only authority that can guarantee "we will not double-charge this order." Rejected as insufficient.

### Idempotency at the database only

Relying on the unique column alone would mean every retry pays for a full request execution before the database rejects the duplicate. The HTTP middleware short-circuits at the boundary so the retry returns the cached response without re-entering the service. The two layers compose cleanly. Rejected as wasteful.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module ownership.
- [ADR-0008](./0008-plugins-as-npm-packages.md) — why plugins must not depend on api types.
- [ADR-0007](./0007-money-as-integers.md) — `bigint` amounts at every column and call site.
- `apps/api/src/modules/payments/providers/types.ts` — the service-facing interface.
- `apps/api/src/modules/payments/providers/registry.ts` — the registry.
- `apps/api/src/modules/payments/providers/plugin-adapter.ts` — the bridge.
- `apps/api/src/modules/payments/service.ts` — the consumer.
- `packages/core/src/plugin.ts` — the plugin-facing `PaymentProvider`.
