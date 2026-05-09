# ADR-0015: Plugin loader and extension points

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

[ADR-0008](./0008-plugins-as-npm-packages.md) commits the project to npm-format plugins registered through a `mt-commerce.config.ts`. That decision settles the _packaging_ of plugins. It does not settle the runtime mechanics: where the loader looks for the config, what happens when a plugin's `setup` throws, what `definePlugin` actually does, what extension points exist, and how the example plugin proves the surface works.

Concretely:

- A plugin author writes `definePlugin({ name, version, setup })`. Should `definePlugin` validate the manifest, or just narrow types?
- An operator who has not adopted plugins should still be able to boot the api. Where is the line between "plugins are optional" and "a misconfigured plugin set is fatal"?
- mt-commerce.config.ts can sensibly live next to the api (`apps/api/`) or at the workspace root. Which is canonical?
- v0.1 needs _some_ extension points to ship. Which ones?
- Should the example plugin be inline test fixtures or a real workspace package?

These are small decisions individually. Together they shape what the plugin ecosystem feels like to authors and operators.

---

## Decision

**`definePlugin` is identity.** It returns its argument unchanged. Type inference is the only contribution. The loader does its own shape check at registration time (`name: string`, `version: string`, `setup: function`).

**The loader is lenient by default.** A missing config file is an info-level log and a clean boot with no plugins. A config file that throws on import is logged as an error and the api still boots. A plugin's `setup` that throws is logged with the plugin name and the rest of the plugin list still loads. Operators who treat plugins as load-bearing can flip `MT_COMMERCE_STRICT_PLUGINS=true` to get fail-fast behaviour.

**Config path is `apps/api/mt-commerce.config.ts`** as the canonical location. The workspace root (`<root>/mt-commerce.config.ts`) is a fallback. The `MT_COMMERCE_CONFIG` environment variable overrides both for tests and ephemeral deployments.

**v0.1 extension points are four:**

1. `registerPaymentProvider(provider)` — wires into the payments registry.
2. `registerShippingProvider(provider)` — wires into the shipping module's plugin sub-registry, keyed by `code`.
3. `registerNotificationChannel(channel)` — wires into the notification service's plugin channel sub-registry.
4. `on(event, listener)` — subscribes to typed domain events from the in-process bus.

`@mt-commerce/plugin-example` is a **real workspace package** under `packages/plugins/example/`. It has its own `package.json`, `peerDependencies` on `@mt-commerce/core`, its own tests, and its own build target.

---

## Consequences

### Positive

`definePlugin` as identity keeps the contract honest. A plugin author who wants to skip the helper and hand-roll a `Plugin` literal can do so — the loader checks shape, not provenance. The helper exists for type inference and for symmetry with `defineConfig`; making it do more would be either a runtime cost the well-formed case does not need, or a duplicate validation path the loader already covers.

The lenient-by-default loader matches the audience. Most operators come to mt-commerce because they need a payment provider plugin or a shipping plugin; their api should boot even if the plugin's startup fails because of, say, a missing `MIDTRANS_SERVER_KEY`. An info-level log "skipping plugin X — setup failed" plus a clean boot is far better than a tight loop of process restarts as systemd tries to recover. The strict-mode escape hatch covers the operator who genuinely wants "if my payment plugin can't load, do not accept orders" — they opt in explicitly.

The canonical config path lives next to the api because that is what ships in the deployment artifact. A merchant deploying mt-commerce builds the api package, includes its `mt-commerce.config.ts`, and ships. The workspace-root fallback covers monorepo developers who keep config one level up; the env override covers tests and ephemeral overrides.

The four extension points are the minimum that lets a v0.1 plugin do useful work. Payment providers and shipping providers are the headline use cases (Indonesian merchants want Midtrans / Xendit / Biteship integration on day one). Notification channels cover SMS/push/WhatsApp Cloud, which several operators have asked for. Event listeners cover everything else — analytics fanout, CRM sync, audit-log mirroring — without growing the contract.

A real workspace package as the example is the right shape because:

- It exercises the actual build pipeline plugin authors will use (`tsc`, `peerDependencies`, ESM exports). An inline fixture would not catch a packaging mistake the same way.
- It serves as a copy-paste template. The plugin author guide (`apps/docs/src/content/docs/plugins/author-guide.mdx`) says "look at `@mt-commerce/plugin-example`," and that pointer goes to a directory the author can read straight through.
- The api's plugin-loader integration tests use it as the under-test fixture, so the example is _also_ what proves the loader works end-to-end. One artifact, two roles.
- Operators can drop the example into their `mt-commerce.config.ts` to confirm their api boots with plugins enabled. Smoke testing the wiring is decoupled from smoke testing any specific plugin.

### Negative

`definePlugin` doing nothing means a manifest with a typo (missing `setup`) is caught at the loader, not at `definePlugin` itself. The error message is precise either way (the loader logs the field and the plugin name), but a TypeScript-savvy author might expect the helper to do more.

Lenient-by-default means a quietly-broken plugin can ship to production unnoticed. We mitigate this by: logging at error level (visible in standard log aggregation), exposing loaded-plugin state for a future `/admin/v1/plugins` endpoint, and recommending operators run `MT_COMMERCE_STRICT_PLUGINS=true` in CI/staging to surface plugin failures during deployment validation.

The `apps/api/mt-commerce.config.ts` location couples the config to the api package. An operator who would prefer to keep their config outside the deployment artifact (mounted as a Kubernetes ConfigMap, say) uses the env-variable override. The two-tier lookup is one more shape to learn.

The four extension points are not the entire wishlist. There is no admin-UI extension point (plugins cannot register routes or admin pages in v0.1), no schema extension (plugins cannot add tables or migrations), and no middleware extension (plugins cannot intercept requests). These are deferred deliberately — each opens questions about admin surface compatibility, migration ordering, and request-path security that v0.1 does not have answers for.

---

## What the loader does NOT do

- **Hot reload.** A plugin set change requires an api restart. The loader runs once per process.
- **Dependency ordering between plugins.** Plugins load in the order they appear in `plugins: [...]`. A plugin that registers an event listener must appear after the plugin that emits the event — but in v0.1 only the api emits, so this only matters between two plugins that listen to each other.
- **Sandbox plugin code.** A plugin runs in the same process with the same permissions as the api. The npm-package model assumes operators trust their own dependencies.
- **Schema migrations from plugins.** Plugins cannot add tables. A plugin that needs persistence stores its data on the columns it has access to (notifications.payload, audit_log.details) or asks the operator to run their own out-of-band migration.

---

## Alternatives considered

### Validate the manifest in `definePlugin`

`definePlugin` could check that `name` is a valid npm-style identifier, that `version` parses as semver, and that `setup` accepts exactly one argument. It was rejected because:

- The loader already does the shape check and produces a useful error with the plugin's manifest in scope.
- A `definePlugin` that throws becomes an import-time hazard — a plugin author's `package.json` typo would crash the operator's api at module evaluation, before the loader can apologise gracefully.
- Plugin authors who do not use `definePlugin` (a hand-rolled object that happens to satisfy the type) bypass the validation entirely. Putting the check in the loader makes it apply uniformly.

### Strict-by-default loader

Failing fast on any plugin error matches a "plugins are infrastructure" intuition. It was rejected because most plugin failures at boot are configuration problems (missing env var, typo in `mt-commerce.config.ts`) and the api should still come up so the operator can SSH in and fix the config. The strict-mode env var covers operators who genuinely want the opposite.

### Workspace root as the canonical config path

`<root>/mt-commerce.config.ts` was an early default. It was demoted to the fallback once it became clear that the config travels with the api deployment artifact. An operator deploying just the api (without the rest of the monorepo) needs the config to be next to the api code.

### Inline plugin example as test fixtures

Having the example plugin live inside `apps/api/tests/fixtures/` was simpler. It was rejected because plugin authors would not be able to read it as a template without understanding the api's test setup. A real package is also what an author _will_ ship — the example should match.

### Schema extension via plugins from day one

A plugin extension point that lets plugins add tables and migrations was considered and deferred. It opens questions about migration ordering across plugins, what happens when a plugin is removed (do the tables stay? get dropped?), and admin surface for plugin-owned data. v0.1 plugins store what they need on existing columns or live entirely external to the database. We will revisit when there is concrete demand.

---

## Related

- [ADR-0008](./0008-plugins-as-npm-packages.md) — npm-format packaging and the operator-facing config shape.
- [ADR-0005](./0005-modular-monolith.md) — module ownership; plugin context wires into module-local registries.
- [ADR-0012](./0012-payment-provider-interface.md) — `registerPaymentProvider` plumbing.
- [ADR-0013](./0013-shipping-fulfillment-lifecycle.md) — `registerShippingProvider` plumbing.
- [ADR-0014](./0014-notification-listeners.md) — `registerNotificationChannel` and event-listener idempotency.
- `packages/core/src/plugin.ts` — `definePlugin`, `defineConfig`, `PluginContext`, the four extension-point interfaces.
- `apps/api/src/lib/plugins.ts` — the loader.
- `packages/plugins/example/` — the reference plugin.
- `apps/docs/src/content/docs/plugins/author-guide.mdx` — the author-facing guide.
