/**
 * PromoBanner — thin band above the header announcing a single promo line.
 *
 * Why a React island rather than an Astro-only component:
 *   - Dismiss state is per-visitor and lives in `localStorage`. Reading
 *     storage at SSR is impossible; reading it inline at runtime would be a
 *     `<script>` tag, which we avoid here.
 *   - A wrong-on-first-paint banner that flickers away is worse than no
 *     banner at all. We mount with `client:load` so the dismiss check runs
 *     before paint on hydration. The server renders nothing for this island
 *     and the client decides whether to show it.
 *   - `client:idle` would be cheaper but defers past LCP, which is exactly
 *     when a layout shift hurts. `client:load` is the right trade.
 *
 * Storage contract:
 *   - Key: `mt:promo-dismissed-v1` (value: any non-empty string — we write
 *     "1"). The `-v1` suffix is the version pin: when an operator wants a
 *     stale dismissal to be re-shown, they bump the constant below to v2,
 *     which makes every prior dismissal stop matching and the new banner
 *     appear again.
 *   - Reads/writes are wrapped in `try/catch` so privacy-mode browsers that
 *     throw on `localStorage` access never crash the island.
 *
 * Visual & motion:
 *   - `bg-fg` near-black band, `text-cream` text. Single solid color, no
 *     gradient. Heights match the spec: 36px mobile, 32px desktop.
 *   - Dismiss collapses height over 200 ms when motion is allowed; for
 *     `prefers-reduced-motion: reduce` the panel disappears instantly. We
 *     keep the element mounted during the collapse animation, then unmount
 *     so the sticky header reflows to the top of the document.
 *
 * Accessibility:
 *   - `role="region"` + localized `aria-label` so screen-reader users can
 *     navigate to or skip the banner via landmarks.
 *   - Dismiss is a real `<button type="button" aria-label="…">` — the icon
 *     itself is `aria-hidden`. No focus trap is needed because the banner
 *     is not modal.
 */
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

const STORAGE_KEY = "mt:promo-dismissed-v1";

/** ms — must match the height-collapse transition in the className below. */
const COLLAPSE_MS = 200;

export interface PromoBannerProps {
  /** Localized promo line. */
  text: string;
  /** Localized close button label (a11y, never visible). */
  dismissLabel: string;
  /** Localized landmark label for the banner region. */
  regionLabel: string;
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // Privacy mode etc. — treat as "not dismissed" but accept that the
    // dismiss won't persist. The banner can still be dismissed for the
    // current session via the visible state below.
    return false;
  }
}

function writeDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Same rationale as readDismissed — silent.
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function PromoBanner({
  text,
  dismissLabel,
  regionLabel,
}: PromoBannerProps) {
  // Three discrete visibility states:
  //   - "open": rendered at full height.
  //   - "collapsing": rendered with height transitioning to 0 (motion only).
  //   - "closed": fully unmounted; sticky header reflows to the top.
  // Initial state is computed lazily so SSR-output is consistent — the
  // island starts un-rendered on the server and the first client render
  // decides based on localStorage.
  const [state, setState] = useState<"open" | "collapsing" | "closed">(() =>
    readDismissed() ? "closed" : "open",
  );

  // After a collapse animation completes, drop the element from the DOM so
  // the sticky header reflows. We schedule the unmount on entering
  // "collapsing"; the timeout matches `COLLAPSE_MS`.
  useEffect(() => {
    if (state !== "collapsing") return;
    const timer = window.setTimeout(() => setState("closed"), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "closed") return null;

  const handleDismiss = () => {
    writeDismissed();
    if (prefersReducedMotion()) {
      setState("closed");
    } else {
      setState("collapsing");
    }
  };

  // The wrapper carries `overflow-hidden` so the height collapse is clean
  // (text doesn't visually escape during the animation). We animate the
  // grid-template-rows trick — content gets row 1fr (open) → 0fr
  // (collapsing) — which is the cleanest way to height-animate to "auto"
  // without measuring. Tailwind's arbitrary value syntax keeps the rule
  // co-located.
  const collapsing = state === "collapsing";

  return (
    <div
      role="region"
      aria-label={regionLabel}
      // Sits in normal flow above the sticky header. z-index is left
      // unset on purpose: the cart drawer (z-50) and the sticky header
      // (z-40) handle their own stacking, and the banner doesn't need
      // to participate in either layer.
      className={[
        "bg-fg text-cream",
        "grid",
        "transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        collapsing ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
      ].join(" ")}
    >
      <div className="overflow-hidden">
        <div className="mx-auto flex h-9 max-w-[1280px] items-center justify-between gap-4 px-5 md:h-8 md:px-8">
          {/*
            Spacer to balance the trailing dismiss button so the text reads
            optically centered. Hidden from assistive tech.
          */}
          <span aria-hidden="true" className="h-7 w-7 md:h-6 md:w-6" />
          <p className="t-caption text-cream flex-1 text-center tracking-[0.04em]">
            {text}
          </p>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={dismissLabel}
            className="text-cream hover:text-cream/80 -mr-1 flex h-7 w-7 items-center justify-center transition-colors duration-150 md:h-6 md:w-6"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={14}
              strokeWidth={1.5}
              aria-hidden
            />
          </button>
        </div>
      </div>
    </div>
  );
}
