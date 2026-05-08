# Storefront UX audit

A walkthrough of the Astro + React-island storefront against Vercel's Web
Interface Guidelines and the documented Saturdays NYC × Muji direction.
Findings are reported as `file:line — finding` and grouped by file. Pure
passes are skipped. Headline complaint first.

The audit was performed on the 2026-05-08 working tree. Subsequent commits
in this branch apply the prioritised fixes; this document captures the
"before" state so reviewers can read the rationale alongside the diff.

---

## Headline finding — add-to-cart feedback is invisible

The user's stated symptom: "when I add to cart, there's no animation or
feedback so the customer doesn't know it succeeded." Three independent
problems combine to produce that experience.

1. `apps/storefront/src/components/Header.astro:24` — `CartDrawer` is
   imported but never rendered anywhere in the DOM tree. The drawer is
   listening for `mt:cart-open` from a never-mounted island, so the
   `openDrawer()` call inside `AddToCartButton.onAdd` dispatches an event
   into the void. This is the root cause: the drawer the design relies on
   is not on the page.
2. `apps/storefront/src/islands/CartCountBadge.tsx:21` — the badge updates
   silently. There is no transform/colour signal tied to a count delta, so
   even the one piece of feedback that _is_ live (the count number changing
   from 1 to 2) is invisible at a glance.
3. `apps/storefront/src/islands/AddToCartButton.tsx:91` — the only
   reliable signal is a 900 ms label flip from "Tambah ke keranjang" to
   "Ditambahkan". Helpful, but lonely. The button reads the same way after
   the flip as it did before, and there is no checkmark or icon swap to
   tell the eye that anything changed.

These are addressed in priority 1 of the fix pass.

---

## Header.astro

`apps/storefront/src/components/Header.astro:24` — `CartDrawer` imported
but the `<CartDrawer />` element is absent from the markup. See headline
finding above.

`apps/storefront/src/components/Header.astro:144-149` — the search
disclosure uses `<details><summary>` but the input inside it has
`autocomplete="off"`. WIG: form inputs should pick the right autocomplete
token. The header search box is a recall surface, so `autocomplete` is OK
to leave off, but the input could carry `enterkeyhint="search"` so iOS
shows the right submit key.

`apps/storefront/src/components/Header.astro:186-190` — the
`data-cart-count` dot is dead markup; it never updates because the cart
count is now driven by `CartCountBadge`. The orphan element is harmless
but reads as drift in the source.

`apps/storefront/src/components/Header.astro:60-79` — the mobile menu uses
`<details>/<summary>`. There is no `aria-controls` linking the summary to
the `nav` element below; not strictly required (the disclosure pattern is
fine on its own), but the menu does not close when a user navigates by
clicking a link inside it (because Astro view-transition swaps reuse the
same `<details>` element). Acceptable trade-off; flagging only because
the next pass at the header could close the disclosure on `astro:after-swap`.

---

## Footer.astro

No accessibility or motion findings; the footer is calm and structurally
correct. One minor copy nit: `Footer.astro:97` uses `©` ligature inline,
fine as-is.

---

## BaseLayout.astro

`apps/storefront/src/layouts/BaseLayout.astro:157-168` — there is no skip
link, and `<main>` does not carry an `id`. WIG: "include skip link for
main content".

`apps/storefront/src/layouts/BaseLayout.astro:155` — `ClientRouter` is
present but the layout has no global mount for the cart drawer. Adding it
here is the right move — the drawer is global UI, not header chrome.

`apps/storefront/src/layouts/BaseLayout.astro:123-128` — Geist font loads
from Google Fonts via `<link rel="stylesheet">`. WIG: critical fonts
should `preload` and use `font-display: swap`. The `&display=swap` query
is set; an explicit `<link rel="preload" as="font">` is missing, but the
trade-off here (Google's stylesheet handles the font CSS) is acceptable.
No fix.

---

## global.css

`apps/storefront/src/styles/global.css` — no `prefers-reduced-motion`
guard. WIG: "honor `prefers-reduced-motion`". The pulse animation on
`.skeleton` runs unconditionally, and the upcoming badge bump and drawer
slide will need the same guard.

`apps/storefront/src/styles/global.css` — no `-webkit-tap-highlight-color`
override. Mobile Safari paints a translucent grey highlight on every link
tap; the brand-specified focus ring already covers feedback.

`apps/storefront/src/styles/global.css` — no `text-wrap: balance` on `h1`
elements (or any heading). WIG suggests it for headings.

`apps/storefront/src/styles/global.css:79-83` — focus-visible ring is
defined globally. Good. Verified it cascades through the islands.

---

## AddToCartButton.tsx

`apps/storefront/src/islands/AddToCartButton.tsx:91-93` — only signal on
success is the 900 ms label flip. No icon swap, no badge bump, no drawer
because the drawer is not mounted. (See headline.)

`apps/storefront/src/islands/AddToCartButton.tsx:78` — `openDrawer()` is
correct conceptually but currently a no-op due to the missing
`<CartDrawer />` mount.

`apps/storefront/src/islands/AddToCartButton.tsx:97-105` — the button uses
`btn-primary`, which has a `transition` on background-color and opacity.
Acceptable; but the current redesign goal is to _layer_ a checkmark icon
on top of the label flip so the visual change is unmistakable.

`apps/storefront/src/islands/AddToCartButton.tsx:98` — missing
`touch-action: manipulation` (and the global CSS doesn't set it either).
WIG: interactive elements should set `touch-action: manipulation`.

---

## CartProvider.tsx

`apps/storefront/src/islands/CartProvider.tsx:101-104` —
`broadcastCartChange` dispatches a CustomEvent with no detail. The badge
cannot tell whether the change is an `add` (count went up) vs a
`remove`/`clear` (count went down or to zero). Without that hint the
badge cannot decide whether to bump (success animation) or do nothing.

`apps/storefront/src/islands/CartProvider.tsx:106-109` —
`openCartDrawer` looks fine. No bug here once the drawer is actually
mounted.

`apps/storefront/src/islands/CartProvider.tsx:215-235` — `addItem` flips
`loading` to true while in flight. The header badge consumes this, so the
badge briefly hides during an add (not user-visible but worth noting).

---

## CartCountBadge.tsx

`apps/storefront/src/islands/CartCountBadge.tsx:21-28` — the badge has
`aria-hidden="true"`. WIG: dynamic counts should be in an `aria-live`
region (or be exposed to assistive tech with surrounding text). The
header anchor's `aria-label` says "Cart" but doesn't include the count.
Recommend pairing the visible badge with a polite live region so the new
count is announced after a successful add.

`apps/storefront/src/islands/CartCountBadge.tsx:22` — no transition. As
the headline calls out, the count number flipping silently is the loudest
silent feedback in the app.

---

## CartDrawer.tsx

`apps/storefront/src/islands/CartDrawer.tsx:138` — `if (!open) return
null` means the dialog doesn't exist in the DOM until a user opens it for
the first time. Fine for performance, but the empty state is also styled
as a bare `<div>` — which means the slide-in animation cannot be a CSS
transition (you can't transition into existence). For the auto-open after
add-to-cart, we need the panel to slide _in_. Mount once, toggle visual
state via class.

`apps/storefront/src/islands/CartDrawer.tsx:144-148` —
`overscroll-behavior: contain` is missing on the panel. WIG: drawers and
sheets should set this so the body doesn't bounce-scroll behind the
modal.

`apps/storefront/src/islands/CartDrawer.tsx:200` — line item shows
`item.variantId` as the product name. That's a UUID. The cart line DTO
does not yet carry the resolved title, so this is the SDK-side gap, not a
storefront bug per se — but the drawer reads as a debug surface today.
Out of scope for this pass; flag for the cart-line title work.

`apps/storefront/src/islands/CartDrawer.tsx:212-217` — the qty input is
`type="number"`. Mobile keyboards open the full numeric pad, fine. No
`inputmode` set; for a tight 0–99 quantity, `inputmode="numeric"` is
slightly nicer. Minor.

`apps/storefront/src/islands/CartDrawer.tsx:152-159` — drawer panel has
no `box-shadow`. The brief allows a _subtle_ shadow on the drawer (it's
the only element where shadows are explicitly permitted). Currently the
drawer reads as flat-on-flat against the body cream; a hairline left
border helps but is on cream-vs-cream and disappears on small screens.

---

## CartPage.tsx

`apps/storefront/src/islands/CartPage.tsx:89` — same line-item issue:
`item.variantId` (UUID) shown as product label. Same root cause as the
drawer; out of scope.

`apps/storefront/src/islands/CartPage.tsx:97-107` — qty input. Same
`inputmode` note as the drawer.

`apps/storefront/src/islands/CartPage.tsx:53-60` — initial loading skeleton
is fine; copy reads "Keranjang Anda" as the title fallback. Loading state
is silent which is correct — the page will populate fast on a typical add.

---

## CheckoutFlow.tsx

`apps/storefront/src/islands/CheckoutFlow.tsx:411-418` — the address card's
billing-different checkbox is clickable label, good. The billing address
fieldset only renders when checked — a `prefers-reduced-motion` user
should not be affected (no animation here), and the keyboard flow works.

`apps/storefront/src/islands/CheckoutFlow.tsx:454-457` — the continue
button shows `"…"` while busy. Acceptable for a 200 ms operation but the
WIG note says "loading states end with …"; the button label should be a
spinner OR a loading word + ellipsis (e.g. "Memuat…"), not a bare
ellipsis. The Confirm button at line 822 uses `labels.review.confirming`
which is the right pattern; the address/shipping/payment buttons should
mirror it.

`apps/storefront/src/islands/CheckoutFlow.tsx:1078-1088` — empty-cart
copy. Has a CTA, ends without a period in some locales — checked the i18n
strings, they are consistent.

`apps/storefront/src/islands/CheckoutFlow.tsx:1167-1219` — sticky aside on
desktop, stacks above content on mobile. No safe-area-inset awareness
needed because this isn't a fixed bottom CTA on the checkout flow.

---

## ProductDetail.tsx

`apps/storefront/src/islands/ProductDetail.tsx:444-454` — sticky bottom
CTA on mobile. WIG: "use `env(safe-area-inset-*)` on sticky bottom
buttons". The sticky wrapper has no `padding-bottom: env(safe-area-inset-bottom)`,
so on iPhones with a home indicator the button can sit under the gesture
bar. Worth a small bump.

`apps/storefront/src/islands/ProductDetail.tsx:386-403` — image wrapper
reserves an aspect ratio (great, prevents CLS) and uses `eager`+
`fetchPriority="high"` on the hero. No `transition:name` for view
transitions — a card-image-to-PDP-hero morph would land cleanly here.

`apps/storefront/src/islands/ProductDetail.tsx:476-509` — related
products are anchors with hover opacity transitions. Uses
`transition-opacity` (good — animates only opacity, per WIG).

`apps/storefront/src/islands/ProductDetail.tsx:319-332` — loading
skeleton is `role="status" aria-live="polite"` with `aria-label`. Good.

---

## ProductGrid.tsx

`apps/storefront/src/islands/ProductGrid.tsx:325-330` — skeleton is in a
`role="status"` region with a label. Good.

`apps/storefront/src/islands/ProductGrid.tsx:347-349` — error state uses
`role="alert"` with the localized error label. The label currently reads
"Gagal memuat produk." which doesn't include a fix or next step. WIG:
"error messages include fix/next step". Could read "Gagal memuat produk.
Coba muat ulang halaman."

`apps/storefront/src/islands/ProductGrid.tsx:354` — empty state is a
single muted line. Calm copy is fine. No CTA — for the home page this is
correct; on the listing page (`/products`) where filters can produce
zero results, a "Hapus filter" CTA would be helpful. (Out of scope for
this pass — filters are already URL-driven, the user can edit the URL.)

`apps/storefront/src/islands/ProductGrid.tsx:382-405` — card image hover
uses `group-hover:opacity-90` with a `transition-opacity duration-200`.
Per WIG (animate only transform/opacity) this is correct.

---

## VariantSelector.tsx

`apps/storefront/src/islands/VariantSelector.tsx:104-129` — chips have
`aria-pressed` to convey selected state, plus a colour border. WIG-style:
adequate.

`apps/storefront/src/islands/VariantSelector.tsx:107-111` — sold-out
chips render with `disabled` + line-through. The `t-body` class is
applied to a disabled button; cursor is `not-allowed`. Good.

No further findings.

---

## SignInForm.tsx

`apps/storefront/src/islands/SignInForm.tsx:149-160` — email input has
`autoComplete="email"`, `type="email"`, `required`. Missing
`spellCheck="false"` and `autoCapitalize="none"` — WIG: "disable
spellcheck on emails, codes, usernames". iOS by default capitalises the
first letter of an email field, which then fails the regex check.

`apps/storefront/src/islands/SignInForm.tsx:177-189` — password input
has `autoComplete="current-password"`. Good.

`apps/storefront/src/islands/SignInForm.tsx:111-114` — focus-on-error
behaviour is in place via `firstInvalid.focus()`. Good.

`apps/storefront/src/islands/SignInForm.tsx:208-214` — submit button
shows `labels.submitting` while busy. Good.

---

## SignUpForm.tsx

`apps/storefront/src/islands/SignUpForm.tsx:234-245` — email input,
same `spellCheck`/`autoCapitalize` gap as sign-in.

`apps/storefront/src/islands/SignUpForm.tsx:262-272` — phone input has
`type="tel"`, `inputMode="tel"`, `autoComplete="tel"`. Good.

`apps/storefront/src/islands/SignUpForm.tsx:297-303` — password has
`autoComplete="new-password"` with `minLength={12}`. Good. Also offers
the hint as `aria-describedby` when no error — accessible.

`apps/storefront/src/islands/SignUpForm.tsx:115-156` — focus-on-first-
invalid pattern. Good.

---

## AccountAddresses.tsx

`apps/storefront/src/islands/AccountAddresses.tsx:613-621` — recipient
input has `autoComplete="name"`. Good.

`apps/storefront/src/islands/AccountAddresses.tsx:628-637` — phone
input has `inputMode="tel"`, `autoComplete="tel"`. Good.

`apps/storefront/src/islands/AccountAddresses.tsx:645-655` — postal code
has `inputMode="numeric"`, `pattern="\d{5}"`, `autoComplete="postal-code"`.
Good.

`apps/storefront/src/islands/AccountAddresses.tsx:175` — delete uses
`window.confirm()` for the confirmation gate. WIG calls for "destructive
actions need confirmation modal or undo window". `window.confirm` is the
minimal-viable confirmation; the platform tone might prefer a calmer
inline confirmation later, but for v0.1 it's defensible.

`apps/storefront/src/islands/AccountAddresses.tsx:179-187` — error
swallowing on delete is silent. WIG: "errors include fix/next step". The
list re-renders unchanged, which technically tells the user the delete
didn't work. A small inline error would be nicer. Out of scope for this
polish pass.

`apps/storefront/src/islands/AccountAddresses.tsx:418-427` — billing
checkbox uses `accent-accent` (Tailwind utility). Good.

`apps/storefront/src/islands/AccountAddresses.tsx:583` — no
`autocomplete="off"` on the form despite WIG suggesting it for
non-auth fields. Acceptable — the recipient/postal/etc. _do_ benefit
from autocomplete.

---

## AccountOrdersList.tsx

`apps/storefront/src/islands/AccountOrdersList.tsx:189-227` — the table
uses semantic `<th scope="col">` headers with a hidden caption. Good.

`apps/storefront/src/islands/AccountOrdersList.tsx:236-251` — pagination
buttons disable correctly at boundaries. The aria-label says
`labels.title` ("Pesanan") which isn't quite right for navigation —
should be `labels.pagination.title` or a more specific string. Minor.

---

## AccountOrderDetail.tsx

`apps/storefront/src/islands/AccountOrderDetail.tsx:209-211` — date is
formatted via `Intl.DateTimeFormat` (good).

`apps/storefront/src/islands/AccountOrderDetail.tsx:253-258` — line items
read product titles from `item.title`, falling back to SKU. Good.

`apps/storefront/src/islands/AccountOrderDetail.tsx:184-191` — not-found
state still shows the back link. Good.

---

## AccountProfileForm.tsx

`apps/storefront/src/islands/AccountProfileForm.tsx:264-271` — readonly
email rendered with `bg-cream` and `text-muted` to look quiet. Good.
Hint copy explains why it's readonly. Good.

`apps/storefront/src/islands/AccountProfileForm.tsx:313-321` — saved
notice fades in then auto-clears after 2.5 s. The transition uses no
`prefers-reduced-motion` guard but the only "animation" is the
appearance/disappearance of the element — there's no transform or opacity
keyframe so reduced-motion is moot.

---

## CheckoutConfirmed.tsx

No findings. Calm layout, proper headings, totals tabular-nums, dates
through Intl. The fallback copy when the sessionStorage handoff is
missing is gentle.

---

## ProductCard.astro

`apps/storefront/src/components/ProductCard.astro:79-87` — image has
`width`/`height` implied via aspect-ratio container and `srcset`/`sizes`.
Good for CLS.

`apps/storefront/src/components/ProductCard.astro:72-75` — the whole
card is a single anchor wrapping image + title + price. Good for
keyboard/screen reader. No `transition:name` for view transitions to
PDP — would be a lovely polish.

---

## Filters.astro

`apps/storefront/src/components/Filters.astro:248` — debounce is 600 ms.
The brief says "debounce confirmed at 300 ms" but the live code uses
600 ms. 300 ms is closer to typical "snappy" search; 600 ms feels
deliberate (low-bandwidth Indonesia). I would _not_ drop to 300 ms
without confirming with the author — leave at 600 ms and document.

`apps/storefront/src/components/Filters.astro:88-93` — search input has
`autocomplete="off"`. Good — recall offering history of past site
searches isn't useful here.

`apps/storefront/src/components/Filters.astro:84` — search input label is
`sr-only`, label-for-id wired correctly. Good.

`apps/storefront/src/components/Filters.astro:185-219` — the price-range
disclosure uses native `<details>` which works without JS. Good.

---

## Pagination.astro

No findings. Text-only, semantic `<nav aria-label="Pagination">`,
`aria-current="page"` on active number. Disabled prev/next render as
`<a aria-disabled>`. Could use `<span>` for the disabled state to be
fully correct (an `<a>` without href shouldn't be focusable, and a
disabled-aria anchor still is in some browsers); current code uses
`pointer-events-none` to soften that. Defensible.

---

## Price.astro

No findings. The `.price-figure` class enforces tabular-nums; modes
default/muted/strike are clear. Good.

---

## Icon.astro

No findings. Decorative-by-default with optional `label` prop for
functional icons. Good.

---

## AccountLayout.astro

`apps/storefront/src/layouts/AccountLayout.astro:51` — sidebar is
`md:sticky md:top-24`. Good.

`apps/storefront/src/layouts/AccountLayout.astro:55-71` — sidebar links
have `aria-current="page"` on the active item. Good.

---

## pages/index.astro

`apps/storefront/src/pages/index.astro:119-161` — hero image fades in via
`object-cover`. Image has `loading="eager"`, `fetchpriority="high"`,
`srcset`. Good for LCP.

`apps/storefront/src/pages/index.astro:151-157` — hero CTA is a link
("Lihat koleksi"), not a button. Correct (it navigates).

---

## pages/search.astro

`apps/storefront/src/pages/search.astro:111-119` — count line is
`aria-live="polite"`. Good.

`apps/storefront/src/pages/search.astro:154-160` — no-results state has
its own polite live region. Good.

---

## pages/products/[slug].astro

`apps/storefront/src/pages/products/[slug].astro:143-162` — passes a
generous label set to the island, including `addedLabel` and
`cartErrorLabel`. Good.

---

## Cross-cutting

### Animation

- `prefers-reduced-motion` is not honored anywhere globally. Skeleton
  pulse animation runs unconditionally. Future motion (badge bump,
  drawer slide, button checkmark) needs to honor the media query.
- No `transition: all` violations spotted in this pass — the codebase
  consistently lists explicit properties.
- View transitions (`ClientRouter`) are wired up but no
  `transition:name` is applied to anything. Card-image-to-PDP-hero,
  hero-headline-to-PDP-title, and a stable cart icon name are all easy
  wins.

### Touch + mobile

- `touch-action: manipulation` is not set in `global.css`. A single rule
  on `a, button, [role="button"]` covers the whole storefront.
- `-webkit-tap-highlight-color` not overridden. The grey iOS flash
  competes with the focus-visible ring.
- `env(safe-area-inset-bottom)` missing on the mobile sticky CTA in
  `ProductDetail`.

### Hydration

- All islands hydrate via `client:load` (or `client:idle` for the
  `HeaderAccountLink`). Inputs that have `value` also have `onChange`.
  No hydration mismatches found.

### Locale

- Dates: `toLocaleDateString` everywhere with the BCP-47 locale. Good.
- Numbers/currency: `format` from `@mt-commerce/core/money` (which uses
  `Intl.NumberFormat`). Good.
- No `translate="no"` markers on brand strings — the wordmark
  "mt-commerce" appears in body copy occasionally; for browser auto-
  translate this could be an issue. Low priority.

### Copy

- No `...` (three dots) found in i18n strings; existing copy already
  uses the proper ellipsis where necessary or is bare. Curly-quote
  pass not strictly needed for the bilingual strings (Indonesian uses
  double-quotes too), but worth a sweep when copy stabilises.
- "Loading…" pattern: `aria-busy` is set but no inline visible "memuat…"
  is used — the skeleton block is the loading affordance, which reads
  as calmer than text.

---

## What this audit did not cover

- Backend correctness or the SDK shape — only the storefront UI is
  in scope.
- The admin app, docs site, and email templates.
- A full Lighthouse / axe-core scan. The findings above are static
  reading; an automated pass would surface contrast or perf details
  that need browser instrumentation.
- The cart line-item title (UUID-as-name) issue — that lives in the
  cart-line DTO, not the storefront, and is tracked elsewhere.

The polish commits in this branch address every item flagged at
priority 1-7 in the brief.
