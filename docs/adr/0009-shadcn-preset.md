# ADR-0009: shadcn/ui preset for the admin

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

[ADR-0001](./0001-headless-architecture.md) commits the admin app to Vite + React + TypeScript. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) commits it to shadcn/ui and Tailwind CSS for the design system.

shadcn/ui is not a single decision. Each new project picks:

- A **primitive library**: Radix UI (the original shadcn substrate) or Base UI (newer, from the Material UI team).
- A **style** (theme): one of `nova`, `vega`, `maia`, `lyra`, `mira`, `luma`, `sera`. Styles differ in spacing, radius, typography weight, and component-level treatments.
- A **base color** for Tailwind: `neutral`, `slate`, `stone`, `gray`, `zinc`.
- An **icon library**: `lucide` (the default), `tabler`, `hugeicons`, or others.
- A **font**: defaulted by the preset, swappable.

These choices propagate into every component file added to the repo. Switching primitive libraries later (Radix ↔ Base) requires a `--force --reinstall` and rewrites every installed component. Style and color tweaks are smaller — mostly CSS variables in `index.css`. Icon library swaps require updating import statements across every component.

The choice is therefore worth making deliberately and recording.

---

## Decision

The admin app uses the shadcn preset code **`b1D0eErI`**, which resolves to:

| Field          | Value           |
| -------------- | --------------- |
| Primitive base | Radix UI        |
| Style          | `mira`          |
| Tailwind base  | `neutral`       |
| Icon library   | `hugeicons`     |
| Font           | Geist Variable  |
| Tailwind       | v4              |
| RSC            | off (Vite, SPA) |
| TSX            | on              |

The preset code is the source of truth. Reproducing the configuration is a single command:

```bash
bunx --bun shadcn@latest init --name admin --template vite --preset b1D0eErI
```

The resolved configuration lives in `apps/admin/components.json`.

---

## Consequences

### Positive

Radix UI is shadcn's original substrate. It has the largest set of community examples, the longest accessibility track record, and the most documentation. For a commerce admin where reliability matters more than experimentation, Radix is the lower-risk choice.

The preset code is portable. Anyone running the same command gets the same scaffold. The decision survives shadcn version drift as long as the preset code is preserved on `ui.shadcn.com`.

Tailwind v4 is the current major version and uses CSS-based theming (`@theme inline` in `index.css`) instead of `tailwind.config.js`. Customizations live in one place.

`hugeicons` gives the admin a distinct visual character without locking us in — they are imported as React components like any other icon library. Swapping to `lucide` later is mechanical (update imports, possibly rename a few icons).

The Geist Variable font is loaded via `@fontsource-variable/geist` rather than a CDN, so the admin works offline and on networks that block external font hosts.

### Negative

`hugeicons` is less common in the shadcn ecosystem than `lucide`. Community blog posts and registry components frequently use `lucide-react`; we will need to swap icon imports when we copy patterns from outside (the shadcn skill explicitly calls this out). The cost is small per occurrence but recurring.

The `mira` style is a specific aesthetic choice. If a future brand direction wants a different feel, switching styles touches every CSS variable in `index.css` — manageable but not free.

Choosing Radix over Base means we will not benefit from Base UI's improvements as the library matures. The trade-off is conscious: stability now, with an explicit re-evaluation window once Base is more battle-tested.

`b1D0eErI` is an opaque code. Anyone reading this ADR must visit `ui.shadcn.com` to interpret it without running the CLI. The table above mitigates this by listing the resolved values explicitly.

---

## Alternatives considered

### `radix-nova` (the previous default)

`nova` is the most neutral of the styles — close to the original shadcn aesthetic. It was the first scaffold attempt before the team chose `mira`. `mira` was preferred for its slightly warmer typography and tighter component spacing. Both are valid; the difference is taste, not capability.

### `base-*` variants (Base UI primitives)

Base UI is the newer primitive library, built by the Material UI team. It has cleaner APIs in some places (notably `render` prop instead of `asChild`) and is actively developed. It was rejected for the first releases because:

- Smaller community, fewer examples
- Less time accumulated in production accessibility audits
- Less likely to compose cleanly with third-party shadcn registry items, which mostly target Radix

Re-evaluating Base for v0.2 or later is reasonable as it matures. Switching is a `--reinstall` away.

### `lucide` icons

The default and most common choice across shadcn projects. Rejected for the admin because `hugeicons` was preferred for the visual treatment — but with the explicit understanding that swapping back to `lucide` is mechanical if the choice does not hold up in practice.

### Tailwind v3

Tailwind v4 is the current major version and matches what the shadcn CLI produces. There was no real reason to pin to v3 for a greenfield project.

### Building a custom design system

Considered and rejected. The point of shadcn is owning the components without owning the design system. A custom system from scratch trades months of upfront work for marginal differentiation that a small team cannot maintain alongside the rest of v0.1.

---

## Implementation notes

The scaffold currently lives at `apps/admin/`. The relevant files:

- `apps/admin/components.json` — shadcn configuration, treated as source of truth alongside this ADR.
- `apps/admin/src/index.css` — Tailwind imports and the `@theme inline` block holding all CSS variables.
- `apps/admin/src/components/ui/` — installed shadcn components. Initially: `button.tsx`.
- `apps/admin/src/components/theme-provider.tsx` — light/dark mode provider, included by the preset.

Adding components going forward:

```bash
bun --cwd apps/admin x shadcn@latest add <component>
```

When pulling components from third-party registries (e.g. `@magicui`, `@bundui`), check the added files for hardcoded `lucide-react` imports and rewrite them to `@hugeicons/react` to match `iconLibrary` in `components.json`.

The storefront (`apps/storefront`) will use Tailwind but not necessarily shadcn — Astro with React islands has different needs. That decision is out of scope here and will land in its own ADR if shadcn is reused there.

---

## Reconsideration triggers

This ADR should be revisited if:

- Base UI reaches the point where its ecosystem matches Radix's. At that point, `--reinstall` to a `base-*` preset is on the table.
- A real merchant brand or the project's own visual identity requires a style other than `mira`.
- `hugeicons` becomes a friction point — for example, a needed icon is missing, or third-party shadcn examples take meaningful time to adapt.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — locks in shadcn/ui and Tailwind for the admin
- [ADR-0001](./0001-headless-architecture.md) — the headless decision that led to a separate admin SPA
- [`apps/admin/components.json`](../../apps/admin/components.json) — the resolved configuration

---

## Status update — 2026-05-07

The preset was switched from `b1D0eErI` (`mira` style) to **`buFzG2y`** (`lyra`
style) when the product editor work landed. The substrate, base color, and
icon library are unchanged — the only field that materially shifted is the
component-level `style`.

| Field          | Was (`b1D0eErI`)        | Now (`buFzG2y`)         |
| -------------- | ----------------------- | ----------------------- |
| Style          | `mira`                  | `lyra`                  |
| Base color     | `neutral`               | `neutral` (unchanged)   |
| Primitive base | Radix UI                | Radix UI (unchanged)    |
| Icon library   | `hugeicons`             | `hugeicons` (unchanged) |
| Font           | Geist Variable          | Geist Variable (unchanged) |
| Radius         | `small`                 | `default`               |

`components.json` now reads `"style": "radix-lyra"`. `src/index.css` was
rewritten by the CLI; the only manual follow-up was a small fix to the
generated `spinner.tsx` (the preset spread `React.ComponentProps<"svg">`
onto `HugeiconsIcon`, which expects narrower numeric props — pinned the
prop type to the icon component's surface).

Reproduce with:

```bash
bunx --bun shadcn@latest init --preset buFzG2y --force --reinstall --yes
```

from `apps/admin/`. The `--reinstall` flag overwrites every file in
`src/components/ui/`; custom files (AppShell, pages, etc.) are untouched.
