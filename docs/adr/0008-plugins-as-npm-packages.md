# ADR-0008: Plugins as npm packages

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce is meant to be extended. Payment providers, shipping providers, notification channels, marketplace integrations, and operator-specific business logic all need a way to live alongside the engine without forking it. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) commits the project to a plugin model; this ADR records the packaging and loading mechanism behind that model.

The shape of "what is a plugin?" determines how operators install, version, audit, and update them. A few patterns exist in the wider ecosystem:

**npm packages** — the plugin is a regular package on the npm registry (or any registry, or a tarball, or a git URL). The operator declares it as a dependency and registers it in a config file. This is the WordPress / Strapi / Medusa / Vendure model, adapted to TypeScript norms.

**In-platform marketplace with installer UI** — the platform exposes a UI where operators browse and install plugins. The installer downloads code at runtime. This is closer to the Shopify or WordPress.org model.

**Runtime-downloaded plugins** — plugins are fetched dynamically from a registry at platform startup, without the operator declaring them ahead of time.

**Configuration-only extension** — plugins are JSON or YAML config files interpreted by the platform, with no executable code.

**Webhook-only extension** — extension is purely external; the platform fires webhooks and accepts API calls, and operators run their own services.

Each model trades off in different directions on dependency management, security, discoverability, expressivity, and operational simplicity.

The audience matters. mt-commerce operators include small merchants on a single VPS, agencies running multiple stores, and developers extending the platform for their clients. Most of them will already be using a TypeScript package manager (Bun, npm, pnpm, or yarn) for their own code. A plugin model that fits the tools they already use is much less friction than one that adds a new system to learn.

---

## Decision

Plugins are **npm-format packages** that export a manifest produced by `definePlugin`.

Operators install plugins like any other dependency:

```bash
bun add @my-org/payment-foo
```

They register them in `mt-commerce.config.ts`:

```typescript
import fooPlugin from "@my-org/payment-foo";

export default defineConfig({
  plugins: [fooPlugin({ apiKey: process.env.FOO_API_KEY })],
});
```

The plugin loader reads this config at startup and wires the plugin's contributions into extension points: payment providers, shipping providers, notification channels, event listeners, and admin panels. Hot-reloading is not part of the design.

There is no in-platform marketplace, no runtime download mechanism, and no proprietary plugin format. A plugin is a TypeScript package that uses the same packaging system as everything else in the ecosystem.

---

## Consequences

### Positive

Existing tooling does the heavy lifting. The npm registry handles distribution. Semver handles versioning. Lockfiles handle reproducibility. Dependency resolution, security advisories, scoped packages, private registries, and supply-chain audits all work because plugins are not a special case — they are packages.

The mental model is familiar. Any TypeScript developer already knows how to install a package, pin a version, read a changelog, and review a dependency tree. There is no new packaging format, no platform-specific CLI, and no plugin lifecycle to learn beyond what the host runtime already provides.

The choice of package manager belongs to the operator. Bun, npm, pnpm, and yarn all install npm-format packages. Operators who already standardize on one of them keep their workflow.

The ecosystem is open. Anyone can publish a plugin under their own scope without the project running a marketplace, gating publication, or charging fees. A plugin published as `@my-org/payment-foo` is on the same footing as `@mt-commerce/payment-midtrans`. This is consistent with the open-platform commitments in [`PRODUCT.md`](../../PRODUCT.md).

Type safety is real. Plugins import shared types and helpers from `@mt-commerce/core`. The `definePlugin` function is generic; a plugin that contributes a payment provider is type-checked against the `PaymentProvider` interface at compile time. Mistakes show up as TypeScript errors rather than runtime failures.

The platform stays small. There is no separate plugin runtime to maintain, no marketplace service to operate, no installer UI to keep in sync. The plugin loader is a few hundred lines that read a config and call into the host modules.

### Negative

There is no sandboxing. A plugin runs with the same privileges as the rest of the API process. It can read environment variables, write to the filesystem, open network connections, and call any module. Operators must trust the plugins they install. This is consistent with how almost every serious commerce platform handles extension; sandboxing would require either a different runtime model (separate processes, WebAssembly, etc.) or a much more restricted extension API, both of which trade real cost for partial protection.

Updating a plugin requires reinstalling the package and restarting the process. There is no hot-reload. This is intentional — restarting is a clean state transition that avoids a class of partial-update bugs — but it means operators schedule a brief restart for each upgrade.

Discoverability is up to authors. Without a marketplace, finding a plugin is a matter of searching npm or following a link from documentation. The project will list known first-party plugins and notable community plugins in the docs but will not run a marketplace in v0.1. Some operators will miss the curated experience that a marketplace provides.

Plugins must keep up with the platform. Major versions of `@mt-commerce/core` may change the interfaces plugins depend on. Plugin authors are responsible for compatibility ranges in their `peerDependencies`. The maintainers will document breaking changes carefully, but plugin authors do real work on each major version.

Bad plugins can hurt operators. A plugin with poor error handling, slow code paths, or a memory leak affects the whole API process. This is the cost of the simple, in-process model. Operators are expected to evaluate plugins as they would any other dependency.

---

## Alternatives considered

### In-platform plugin marketplace with installer UI

A marketplace built into the admin, where operators browse plugins and install them with a click, was considered. It is a friendlier experience for non-technical operators.

It was rejected for v0.1 for several reasons:

- It would need a registry service, search infrastructure, listing curation, and a billing story for paid plugins — none of which exists yet, and all of which are large projects on their own.
- It would not remove the underlying need for an npm-package mechanism; the marketplace would have to install something, and that something is a TypeScript package. Building the package model first leaves the marketplace as a layer on top later.
- The first generation of plugins is likely to be authored by developers and agencies, not directly installed by merchants. Developers prefer the package-manager workflow.

A marketplace remains possible as a later layer over the same package mechanism. It is not a replacement for it.

### Dynamic plugin downloads at runtime

A model where the API fetches and loads plugins at runtime, without an explicit `bun add`, was considered. It would let operators enable plugins without touching their dependency manifest.

It was rejected because:

- Supply-chain integrity becomes much harder. There is no lockfile pinning, no audit trail, and no equivalent of `npm audit` against the running set of plugins.
- Restart-time installation is hostile to immutable container images, which are the recommended deployment shape.
- The mental model splits: some dependencies live in `package.json`, others live somewhere else. Operators have to track both.

Static dependency declaration trades a small amount of friction (one `bun add`) for a much more auditable system.

### Forking the core

Modifying the engine directly to add a payment provider or a notification channel is technically possible — the project is MIT-licensed ([ADR-0002](./0002-license.md)) — but it defeats the purpose of an extensible platform. A fork drifts from upstream, accumulates merge conflicts, and forces the operator to maintain their own release cadence.

Plugins exist so operators do not have to fork. Forking remains a legitimate option for operators with deeply custom needs, but the platform should not expect it.

### Configuration-only extension (no code)

A model where extensions are JSON or YAML config files, interpreted by the platform, was considered. It is appealing for simple cases — a static list of payment methods with their API keys — and avoids the security questions around running arbitrary code.

It was rejected because the actual extension points need real code. A new payment provider implements a `capture` method that calls the provider's API, handles its quirks, and translates its responses. A new shipping provider computes rates against a real rate engine. A notification channel formats messages for a specific service. None of this is expressible as configuration without an interpreter that is, in effect, a programming language.

Configuration-only models work for narrow extension surfaces (feature flags, simple field toggles). They do not work for provider integration.

### Webhook-only extension

A pure webhook model — the platform fires events to operator-controlled URLs and accepts updates through the API — was considered. mt-commerce already supports outgoing webhooks ([`ARCHITECTURE.md`](../../ARCHITECTURE.md)) for exactly this kind of integration.

It was rejected as the only extension mechanism because it does not cover providers that need to render UI in the admin (a payment provider's settings panel, a shipping provider's configuration form), and it adds operational cost (the operator runs a separate service, with its own deployment, monitoring, and authentication) that small merchants cannot reasonably absorb. Webhooks remain valuable for some integrations and complement the plugin model rather than replace it.

---

## Implementation notes

The following commitments follow directly from this decision:

- The first extension points are payment providers, shipping providers, notification channels, and event listeners. Admin panels are supported through `adminPanels` entries on the manifest. More extension points will be added as the platform matures.
- Plugins import shared types from `@mt-commerce/core`. The `definePlugin` function is the single entry point for declaring contributions.
- Plugin packages declare their compatible mt-commerce range through `peerDependencies` against `@mt-commerce/core`.
- The plugin loader runs at API startup. It reads `mt-commerce.config.ts`, resolves each plugin manifest, and registers contributions with the relevant modules. Failures during loading abort startup with a clear error rather than running with a half-loaded plugin.
- Hot-reloading is explicitly out of scope. Updating a plugin requires reinstalling the package and restarting the process, consistent with the deployment patterns documented in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
- First-party plugins live under the `@mt-commerce/` scope at `packages/plugins/` in the monorepo. They use exactly the same plugin API as third-party plugins; there is no privileged path.
- The maintainers will publish a short authoring guide and a starter template in the documentation. A list of known plugins will be maintained in the docs without becoming a marketplace.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the plugin model overview and extension points
- [ADR-0001](./0001-headless-architecture.md) — the headless decision that motivates a public extension surface
- [ADR-0002](./0002-license.md) — the permissive license under which plugins are distributed
- [ADR-0005](./0005-modular-monolith.md) — the internal module shape that plugins extend through
- [`PRODUCT.md`](../../PRODUCT.md) — the open-platform principles behind a non-gatekept ecosystem
