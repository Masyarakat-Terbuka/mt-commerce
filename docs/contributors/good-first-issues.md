# Good first issues — initial batch

This is a working draft of 20 small, well-scoped tasks that a first-time
contributor can pick up. Each one is sized for a few hours of focused work,
touches a single area, and has a clear definition of done.

The maintainer should review this list, sharpen any wording, then open each
one as a GitHub issue using the **Good first issue** template (or the helper
at the bottom of this file). Items are grouped by area, not priority.

Open issues should carry: `type: task`, `good first issue`, `status: ready`,
`effort: small`, plus the matching `area:` label.

---

## Tooling and repository hygiene

### 1. Add commitlint with conventional commits

**Labels:** `type: chore`, `area: ci`, `good first issue`, `effort: small`

**What needs to happen.** Add `@commitlint/cli` and `@commitlint/config-conventional` as root devDependencies, create `commitlint.config.js`, and document the commit message format in `CONTRIBUTING.md`.

**Why this matters.** Conventional commits make the changelog generate-able and let contributors and reviewers tell at a glance what kind of change a commit is.

**Where to start.** Root `package.json`, new `commitlint.config.js` at the repo root, the "Writing commits" section of `CONTRIBUTING.md`.

**Acceptance criteria.**
- [ ] `bunx commitlint --from HEAD~1` runs without error on a well-formed message.
- [ ] A malformed commit message (`fix stuff`) is rejected.
- [ ] `CONTRIBUTING.md` lists the allowed types (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`).

**How to test.** Run `echo "fix stuff" | bunx commitlint` and confirm exit code is non-zero.

**Out of scope.** Wiring commitlint to a Git hook — that is issue #2.

---

### 2. Set up Husky pre-commit hook with lint-staged

**Labels:** `type: chore`, `area: ci`, `good first issue`, `effort: small`

**What needs to happen.** Add `husky` and `lint-staged` to the root, configure a pre-commit hook that runs Prettier and ESLint only on staged files, and add a commit-msg hook that runs commitlint.

**Why this matters.** Catches formatting and lint issues before they enter the history. Keeps CI green and reviews focused on substance.

**Where to start.** Root `package.json` (`prepare` script + `lint-staged` config), `.husky/pre-commit`, `.husky/commit-msg`.

**Acceptance criteria.**
- [ ] `bun install` installs hooks via `husky init` (no manual step needed).
- [ ] Staging an unformatted file triggers Prettier on it.
- [ ] An ESLint error in a staged file blocks the commit.
- [ ] Depends on issue #1 being merged first (commitlint config exists).

**How to test.** Stage a file with bad formatting, run `git commit`, observe Prettier reformats it before the commit succeeds.

**Out of scope.** Pre-push hooks; full-tree linting (only staged files).

---

### 3. Write `docs/development/getting-started.md`

**Labels:** `type: docs`, `area: docs`, `good first issue`, `effort: small`, `bahasa-pending`

**What needs to happen.** Write a short, accurate "first 10 minutes" guide: prerequisites, clone, `bun install`, `docker compose up`, `bun dev`, where each app runs, troubleshooting tips for common errors.

**Why this matters.** A new contributor who cannot get the project running in 15 minutes will not contribute. This page is the funnel.

**Where to start.** Read `README.md` Quick Start section and `.env.example`. Run the steps yourself on a clean clone and write down what actually happens, not what should happen.

**Acceptance criteria.**
- [ ] A new developer can follow the doc end-to-end without asking a question.
- [ ] Covers macOS and Linux; notes Windows + WSL where relevant.
- [ ] Lists the four URLs where API / admin / storefront / Swagger UI run.
- [ ] Adds a `bahasa-pending` companion issue for the Indonesian translation.

**How to test.** Hand the doc to a friend who has never seen the repo; they should be unblocked.

**Out of scope.** Production deployment (lives under `docs/deployment`).

---

### 4. Write `docs/development/migrations.md`

**Labels:** `type: docs`, `area: docs`, `area: api`, `good first issue`, `effort: small`, `bahasa-pending`

**What needs to happen.** Document the Drizzle migration workflow: how to change a schema file, how to generate a migration with `drizzle-kit generate`, naming conventions (`0006_orders.sql` style), how migrations are applied in dev and CI, and the forward-fixing policy.

**Where to start.** Look at the existing migrations in `apps/api/drizzle/migrations/` and the schema files in `apps/api/src/db/schema/`. Read ADR-0003 for context.

**Acceptance criteria.**
- [ ] Step-by-step from "I added a column" to "migration is in PR."
- [ ] Includes the rule from `ARCHITECTURE.md`: forward-fixing over down-migrations.
- [ ] Calls out the `audit_log` exception (financial entities never hard-delete).

**How to test.** A reviewer follows the doc to add a trivial column; the result matches the doc.

**Out of scope.** Designing the `audit_log` table itself (that is its own issue).

---

### 5. Add a `CODEOWNERS` file

**Labels:** `type: chore`, `area: ci`, `good first issue`, `effort: small`

**What needs to happen.** Add `.github/CODEOWNERS` mapping the maintainer org as default owner of everything, with module-specific ownership notes for areas where future maintainers will be assigned.

**Why this matters.** Auto-requests reviews from the right person; signals to contributors who is responsible for what.

**Where to start.** Reference the GitHub CODEOWNERS syntax. Map `*` to the maintainer org and leave a comment block listing the area subdirectories that may grow their own owners.

**Acceptance criteria.**
- [ ] `.github/CODEOWNERS` exists.
- [ ] Opening a PR auto-requests review from the maintainer org.
- [ ] File includes a comment explaining how to add per-area owners later.

**How to test.** Open a draft PR; observe the auto-assigned reviewer.

**Out of scope.** Assigning specific individuals as owners (no community yet).

---

## Storefront polish

### 6. Add SEO meta tags to product pages

**Labels:** `type: feature`, `area: storefront`, `good first issue`, `effort: small`

**What needs to happen.** Add a small `<MetaTags />` Astro component used by `pages/products/[slug].astro` (and the `en/` mirror) that emits `<title>`, `<meta name="description">`, `<link rel="canonical">`, and basic Open Graph tags.

**Where to start.** `apps/storefront/src/layouts/BaseLayout.astro` for the existing head pattern; the product detail page imports from there.

**Acceptance criteria.**
- [ ] Product pages have unique `<title>` and `<meta description>` derived from product data.
- [ ] Canonical URL is correct for both `/produk/...` and `/en/products/...`.
- [ ] A View Source on a product page shows the OG tags.

**How to test.** Run `bun --filter '@mt-commerce/storefront' dev`, open a product, view source.

**Out of scope.** Structured data (issue #8); social-image generation.

---

### 7. Generate `sitemap.xml`

**Labels:** `type: feature`, `area: storefront`, `good first issue`, `effort: small`

**What needs to happen.** Use `@astrojs/sitemap` to emit a sitemap covering home, product list, every product detail page, and language variants.

**Where to start.** `apps/storefront/astro.config.mjs`. The plugin is opinionated; default config is mostly enough.

**Acceptance criteria.**
- [ ] `bun --filter '@mt-commerce/storefront' build` produces `dist/sitemap-index.xml`.
- [ ] All product detail URLs (Bahasa and English) are present.
- [ ] `robots.txt` (issue #9) references the sitemap.

**How to test.** Build, then `cat dist/sitemap-index.xml`.

**Out of scope.** Search submission — that is operator territory.

---

### 8. Add JSON-LD `Product` structured data to product detail pages

**Labels:** `type: feature`, `area: storefront`, `good first issue`, `effort: small`

**What needs to happen.** Inject a `<script type="application/ld+json">` block on product detail pages with schema.org `Product` (name, description, sku, image, offers.price, offers.priceCurrency=`IDR`, offers.availability).

**Where to start.** `apps/storefront/src/pages/products/[slug].astro`. Build the JSON object server-side from the product data already passed to the page.

**Acceptance criteria.**
- [ ] Each product page emits valid JSON-LD with the fields above.
- [ ] Validates clean against Google's Rich Results Test.
- [ ] Currency is `IDR`; price is in whole rupiah (no decimals).

**How to test.** View source on a product page; paste the JSON into the [Schema.org validator](https://validator.schema.org/).

**Out of scope.** Review aggregates, breadcrumbs, organization markup.

---

### 9. Add `robots.txt`

**Labels:** `type: feature`, `area: storefront`, `good first issue`, `effort: small`

**What needs to happen.** Add a `public/robots.txt` to the storefront with a permissive crawler policy and a `Sitemap:` line pointing at `/sitemap-index.xml`.

**Where to start.** `apps/storefront/public/robots.txt`. Disallow nothing for v0.1 except internal-looking paths if any exist.

**Acceptance criteria.**
- [ ] `robots.txt` is reachable at the storefront root.
- [ ] References the sitemap URL.

**How to test.** `curl http://localhost:3000/robots.txt`.

**Out of scope.** Per-environment robots (dev vs prod).

---

### 10. Tighten the 404 page in Bahasa Indonesia

**Labels:** `type: feature`, `area: storefront`, `area: i18n`, `good first issue`, `effort: small`

**What needs to happen.** The current `404.astro` is a placeholder. Make it match the storefront design: header, friendly Bahasa Indonesia message, link back to home and to the product list. Add the English mirror under `pages/en/`.

**Where to start.** `apps/storefront/src/pages/404.astro`, and `i18n/id.json` / `i18n/en.json` for the strings.

**Acceptance criteria.**
- [ ] The 404 page uses `BaseLayout.astro` so it matches the rest of the site.
- [ ] All copy is loaded from `i18n/id.json` and `i18n/en.json`.
- [ ] Two clear actions: "Kembali ke beranda" and "Lihat semua produk" (and English equivalents).

**How to test.** Visit any unknown URL on the dev server; confirm the styled page appears.

**Out of scope.** Server-side error pages (5xx).

---

## `packages/core` helpers

### 11. Add an Indonesian Rupiah formatter

**Labels:** `type: feature`, `area: core`, `good first issue`, `effort: small`

**What needs to happen.** Add `formatRupiah(amount: bigint | number): string` to `packages/core/src/money.ts` (or a new `packages/core/src/format.ts`). Output should match Indonesian convention: `Rp 12.500` (dot as thousands separator, no decimals, space after `Rp`).

**Where to start.** `packages/core/src/money.ts` for the existing `Money` shape; `packages/core/tests/money.test.ts` for the test pattern.

**Acceptance criteria.**
- [ ] `formatRupiah(12500n)` returns `"Rp 12.500"`.
- [ ] `formatRupiah(0n)` returns `"Rp 0"`.
- [ ] Negative values format as `"-Rp 12.500"`.
- [ ] At least 6 unit tests.
- [ ] Exported from `packages/core/src/index.ts`.

**How to test.** `bun --filter '@mt-commerce/core' test`.

**Out of scope.** Other currencies; locale-aware formatting via `Intl`.

---

### 12. Add an Indonesian phone-number validator

**Labels:** `type: feature`, `area: core`, `good first issue`, `effort: small`

**What needs to happen.** Add `validateIndonesianPhone(input: string): { valid: boolean; e164?: string }` that accepts common Indonesian formats (`08xx-xxxx-xxxx`, `+628xx`, `628xx`) and normalizes to E.164 (`+62xxx`).

**Where to start.** New file `packages/core/src/phone.ts`. Look at `packages/core/src/ulid.ts` for the export pattern.

**Acceptance criteria.**
- [ ] Accepts `081234567890`, `+6281234567890`, `6281234567890`, with or without dashes/spaces.
- [ ] Rejects strings that are too short, too long, or do not start with `0`/`+62`/`62`.
- [ ] At least 10 unit tests covering the happy paths and the edges.
- [ ] Exported from `packages/core/src/index.ts`.

**How to test.** `bun --filter '@mt-commerce/core' test`.

**Out of scope.** Carrier identification; landline support.

---

### 13. Add an NPWP format validator

**Labels:** `type: feature`, `area: core`, `good first issue`, `effort: small`

**What needs to happen.** Add `validateNPWP(input: string): boolean`. NPWP is Indonesia's tax ID; the modern format is 16 digits. Validate length and digit-only after stripping common separators (dots, dashes).

**Where to start.** New file `packages/core/src/npwp.ts`. Mirror the structure of issue #12.

**Acceptance criteria.**
- [ ] `01.234.567.8-901.000` is accepted.
- [ ] `1234567890123456` is accepted.
- [ ] Empty string, alpha characters, and wrong-length strings are rejected.
- [ ] At least 6 unit tests.
- [ ] Exported from `packages/core/src/index.ts`.

**How to test.** `bun --filter '@mt-commerce/core' test`.

**Out of scope.** Verifying the NPWP exists at DJP — checksum validation only.

---

### 14. Add an Indonesian address formatter

**Labels:** `type: feature`, `area: core`, `area: customer`, `good first issue`, `effort: small`

**What needs to happen.** Add `formatAddressID(parts: { street, kelurahan, kecamatan, kotaKabupaten, provinsi, postalCode }): string` returning a single line in Indonesian-postal convention: `Street, Kel. Kelurahan, Kec. Kecamatan, KotaKabupaten Provinsi, PostalCode`.

**Where to start.** New file `packages/core/src/address.ts`. `apps/api/src/db/schema/customer_addresses.ts` shows the field shape.

**Acceptance criteria.**
- [ ] Output matches the format above.
- [ ] Missing optional parts (e.g. street line 2) are omitted cleanly without trailing commas.
- [ ] At least 5 unit tests.
- [ ] Exported from `packages/core/src/index.ts`.

**How to test.** `bun --filter '@mt-commerce/core' test`.

**Out of scope.** Multi-line block format for invoices.

---

## Admin app

### 15. Build the login page (visual only)

**Labels:** `type: feature`, `area: admin`, `good first issue`, `effort: small`

**What needs to happen.** Replace the placeholder `App.tsx` with a routed login page using `@/components/ui` primitives (Card, Input, Button, Label). Email + password fields, "Sign in" submit button, brand mark at the top. No API call yet — clicking submit calls a stubbed `onSubmit` that logs to the console.

**Where to start.** `apps/admin/src/App.tsx`, `apps/admin/src/components/ui/`. Shadcn primitives are already installed.

**Acceptance criteria.**
- [ ] A login form renders at `/`.
- [ ] Fields use `Label`, `Input`, and a primary `Button`.
- [ ] Form has client-side `required` validation.
- [ ] All visible strings are stored in a constants module ready for i18n (issue #17).

**How to test.** `bun --filter '@mt-commerce/admin' dev`, open the page, fill the form.

**Out of scope.** Calling the API; routing setup; password reset.

---

### 16. Add a reusable empty-state component

**Labels:** `type: feature`, `area: admin`, `good first issue`, `effort: small`

**What needs to happen.** Add `apps/admin/src/components/empty-state.tsx` accepting `{ icon, title, description, action? }`. Visual style consistent with the shadcn theme. This will be reused on every list page (products, orders, customers).

**Where to start.** Look at how other shadcn projects build empty states (a centered Card with muted-foreground text and an optional CTA button).

**Acceptance criteria.**
- [ ] Component accepts the four props above.
- [ ] Renders correctly on a mocked storybook-like dev page.
- [ ] Has a matching `EmptyState.stories.tsx` or example file in the same dir.

**How to test.** Render the component on a temporary dev route; confirm it looks right.

**Out of scope.** Wiring it into actual list pages — that comes when the list pages exist.

---

### 17. Set up Bahasa Indonesia as the admin's default language

**Labels:** `type: feature`, `area: admin`, `area: i18n`, `good first issue`, `effort: medium`

**What needs to happen.** Add `i18next` (or `react-i18next`) to the admin, configure Bahasa Indonesia as default and English as the alternate, scaffold `src/i18n/{id,en}.json`, and convert any literal strings in existing components to translation keys.

**Where to start.** The admin currently has very few strings (login form once issue #15 lands). This is the right moment to set up i18n before they multiply.

**Acceptance criteria.**
- [ ] App loads in Bahasa by default.
- [ ] A language toggle in the header switches to English.
- [ ] Translation key naming convention is documented in the admin README.
- [ ] No literal user-visible strings remain in components.

**How to test.** Switch language; observe all strings change.

**Out of scope.** Translation completeness across the rest of the (not-yet-built) admin pages.

---

## Process and community

### 18. Create `CHANGELOG.md` with a "Keep a Changelog" scaffold

**Labels:** `type: docs`, `area: docs`, `good first issue`, `effort: small`

**What needs to happen.** Add a `CHANGELOG.md` at the repo root following the [Keep a Changelog](https://keepachangelog.com/) format, with sections for `Unreleased`, `Added`, `Changed`, `Fixed`, `Removed`, `Security`. Pre-fill the `Unreleased` section with what has actually shipped to date (cart, checkout, SDK, auth, catalog).

**Why this matters.** Without a changelog, contributors cannot tell what is in `main` since the last release. With weekly devlog cadence (see project plan), this becomes a living artifact.

**Where to start.** Look at the existing migrations and module READMEs to compile the "what shipped" list.

**Acceptance criteria.**
- [ ] `CHANGELOG.md` exists at the repo root.
- [ ] Format follows Keep a Changelog v1.1.
- [ ] `Unreleased` section reflects current `main` truthfully.
- [ ] `CONTRIBUTING.md` is updated to require a changelog entry on user-facing PRs.

**How to test.** Read it and confirm it tells the story of the project so far.

**Out of scope.** Tagging a release.

---

### 19. Add `.github/FUNDING.yml`

**Labels:** `type: chore`, `area: ci`, `good first issue`, `effort: small`

**What needs to happen.** Add a `.github/FUNDING.yml` so GitHub shows a "Sponsor" button on the repo, pointing to Open Collective, GitHub Sponsors, or whichever channel the maintainer org has registered.

**Why this matters.** Visible sponsorship channels are part of an OSS project's sustainability picture without compromising the open-source ethos.

**Where to start.** Decide which sponsorship platforms are accepting funds for the project. If none yet, this issue is blocked — open issues for "register Open Collective" / "apply for GitHub Sponsors" first.

**Acceptance criteria.**
- [ ] `.github/FUNDING.yml` exists with at least one valid platform.
- [ ] Repo page shows the "Sponsor" button.

**How to test.** Visit the repo's GitHub page after merging.

**Out of scope.** Tax/legal setup of sponsorship platforms.

---

### 20. Document the "good first issue" triage policy in `CONTRIBUTING.md`

**Labels:** `type: docs`, `area: docs`, `good first issue`, `effort: small`, `bahasa-pending`

**What needs to happen.** Add a section to `CONTRIBUTING.md` explaining (a) what makes an issue a "good first issue," (b) how a contributor claims one (a comment), (c) the maintainer's response-time commitment (e.g. weekend reviews), and (d) what happens if a claimed issue stalls (re-opened after 14 days of silence).

**Why this matters.** Sets expectations clearly so first-time contributors are not left wondering whether anyone is reading their work. This is the single biggest predictor of contributor retention in OSS.

**Where to start.** Read `.github/ISSUE_TEMPLATE/good_first_issue.md` for the template; mirror its language.

**Acceptance criteria.**
- [ ] A new "First-time contributors" section in `CONTRIBUTING.md`.
- [ ] States the claim mechanism and the response-time policy explicitly.
- [ ] Translation tracked under `bahasa-pending`.

**How to test.** Read it; ask one external person to confirm it answers their questions.

**Out of scope.** A bot to auto-assign or auto-close stalled issues.

---

## How to open these on GitHub

After reviewing and sharpening, the maintainer can open them all at once with
`gh issue create` once the repo exists. A short pattern:

```bash
gh issue create \
  --repo masyarakat-terbuka/mt-commerce \
  --title "Add commitlint with conventional commits" \
  --milestone "v0.1 Foundation" \
  --label "type: chore,area: ci,good first issue,effort: small,status: ready" \
  --body-file - <<'EOF'
## What needs to happen
...
EOF
```

Or paste each issue's body into the GitHub web UI using the **Good first
issue** template. Either is fine — the goal is that the queue exists, not
how it gets there.
