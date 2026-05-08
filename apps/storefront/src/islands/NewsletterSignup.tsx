/**
 * NewsletterSignup — footer email-capture island.
 *
 * IMPORTANT: this is a v0.1 STUB. There is no list-management service wired
 * up yet, so the submit handler awaits a 300ms timeout to look like a real
 * call and then shows the success state. A successful submit does NOT
 * persist anywhere — the email is dropped on the floor.
 *
 * The component is shipped as-is so the footer's visual surface is real
 * (visitors see a working form, not "coming soon" copy), and so the
 * surrounding markup, validation, and a11y wiring can be reviewed
 * independently of the eventual backend. v0.2 will replace the timeout
 * with a real POST to the list service of choice (likely a thin
 * `/api/newsletter` Astro endpoint that fans out to whichever provider
 * we land on). At that point the only change in this file should be the
 * body of `onSubmit` between `validate()` and `setStatus("success")`.
 *
 * Validation is regex-only — we don't pretend to know if a real mailbox
 * exists. The regex matches `auth/sign_up` to keep "what counts as a valid
 * email" consistent across the storefront.
 *
 * Reduced motion: the success transition uses a CSS opacity fade. When the
 * user has `prefers-reduced-motion: reduce`, we skip the fade duration so
 * the swap is instantaneous (still readable by screen readers via the
 * `role="status"` live region).
 */
import { useId, useRef, useState } from "react";

export interface NewsletterLabels {
  heading: string;
  description: string;
  emailLabel: string;
  emailPlaceholder: string;
  submit: string;
  success: string;
  errorInvalid: string;
}

export interface NewsletterSignupProps {
  labels: NewsletterLabels;
}

// Same shape as the storefront's other email checks (sign-in/sign-up).
// Keeping the regex inline rather than imported from a shared util because
// this island ships in the footer of every page — a one-line regex avoids
// pulling another module into the per-page bundle for a single use.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "idle" | "submitting" | "success" | "error";

export default function NewsletterSignup({ labels }: NewsletterSignupProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Honour prefers-reduced-motion at submit time. Reading at render would
  // require a media-query subscription; sampling once per submit is simpler
  // and the answer almost never changes mid-session.
  function reducedMotion(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const trimmed = email.trim();
    if (!EMAIL_REGEX.test(trimmed)) {
      setStatus("error");
      setErrorMessage(labels.errorInvalid);
      inputRef.current?.focus();
      return;
    }

    setStatus("submitting");

    // STUB: no real endpoint yet. The 300ms delay mirrors a typical
    // request round-trip so the busy state is visible long enough to read.
    // Replace with `await fetch("/api/newsletter", { ... })` in v0.2.
    const minDuration = reducedMotion() ? 0 : 300;
    await new Promise((resolve) => setTimeout(resolve, minDuration));

    setStatus("success");
  }

  if (status === "success") {
    return (
      <div className="space-y-3">
        <h2 className="t-overline text-muted">{labels.heading}</h2>
        <p
          role="status"
          aria-live="polite"
          className="t-body text-fg motion-safe:transition-opacity motion-safe:duration-200"
        >
          {labels.success}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-busy={status === "submitting"}
      className="space-y-3"
    >
      <h2 className="t-overline text-muted">{labels.heading}</h2>
      <p className="t-body text-faint">{labels.description}</p>
      <div>
        <label htmlFor={inputId} className="sr-only">
          {labels.emailLabel}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={inputId}
            ref={inputRef}
            type="email"
            name="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === "error") {
                setStatus("idle");
                setErrorMessage(null);
              }
            }}
            placeholder={labels.emailPlaceholder}
            aria-invalid={status === "error"}
            aria-describedby={errorMessage ? `${inputId}-error` : undefined}
            disabled={status === "submitting"}
            className="border-line bg-paper t-body text-fg placeholder:text-faint focus:border-fg flex-1 border px-3 py-2 transition-colors duration-150 outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            aria-busy={status === "submitting"}
            className="border-line-strong bg-fg text-paper hover:bg-accent t-caption inline-flex items-center justify-center border px-4 py-2 tracking-[0.1em] uppercase transition-colors duration-150 disabled:opacity-60"
          >
            {labels.submit}
          </button>
        </div>
        {errorMessage && (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="t-caption text-danger mt-2"
          >
            {errorMessage}
          </p>
        )}
      </div>
    </form>
  );
}
