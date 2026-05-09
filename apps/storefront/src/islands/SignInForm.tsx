/**
 * SignInForm — single-purpose React island that signs the customer in.
 *
 * Form contract:
 *   - Real `<form>` semantics; the submit handler intercepts and drives the
 *     SDK. JavaScript-disabled visitors still see a usable form layout —
 *     they just don't get the sign-in roundtrip.
 *   - Real labels (`<label htmlFor>`), `aria-invalid`, `aria-describedby` for
 *     errors. The first invalid field is focused on submit failure.
 *   - The whole form is `aria-busy` while the request is in flight; the
 *     submit button shows the busy label.
 *
 * Error mapping — the API surfaces errors as `ApiError` with a stable code.
 * We map the codes to localized strings the parent passes in. Unknown codes
 * fall through to the `generic` message; a transport failure surfaces as
 * `network`.
 *
 * Redirect:
 *   - On success, navigate to `nextHref` (which the parent computes from the
 *     `?next=` query param, or `/account` by default). The cached customerId
 *     is written by the SDK call site, so the destination page can read it.
 */
import { useId, useRef, useState } from "react";
import { ApiError, createClient } from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import { writeCachedCustomerId } from "../lib/account.js";

export interface SignInLabels {
  email: string;
  password: string;
  showPassword: string;
  hidePassword: string;
  submit: string;
  submitting: string;
  errors: {
    invalidCredentials: string;
    network: string;
    generic: string;
    fieldRequired: string;
    invalidEmail: string;
  };
}

export interface SignInFormProps {
  /** Where to navigate after a successful sign-in. */
  nextHref: string;
  labels: SignInLabels;
}

/** Map an `ApiError.code` to one of our localized error keys. */
function mapApiError(err: unknown, labels: SignInLabels): string {
  if (err instanceof ApiError) {
    // Better Auth surfaces credential failures with the code
    // `INVALID_EMAIL_OR_PASSWORD` (or sometimes `INVALID_PASSWORD`). The
    // standard envelope on a 401 from Better Auth lands as our generic
    // `http_error` because it does not match the API's standard envelope
    // — we match on status to be defensive.
    if (err.status === 401 || err.status === 400) {
      return labels.errors.invalidCredentials;
    }
    if (err.code === "network_error" || err.code === "request_timeout") {
      return labels.errors.network;
    }
  }
  return labels.errors.generic;
}

export default function SignInForm({ nextHref, labels }: SignInFormProps) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Show/Hide password toggle — flips the input's `type` attribute. The
  // standard pattern; helpful when the user is unsure whether they typed
  // a 12-char password correctly. Starts off (mask) so a passing shoulder
  // doesn't catch the password by accident.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Light client-side validation. The server is authoritative; this only
  // saves a round-trip for the obvious cases and gives the focus-on-error
  // a11y handler something to point at.
  function validate(): boolean {
    let firstInvalid: HTMLInputElement | null = null;
    let valid = true;

    if (email.trim().length === 0) {
      setEmailError(labels.errors.fieldRequired);
      firstInvalid ??= emailRef.current;
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError(labels.errors.invalidEmail);
      firstInvalid ??= emailRef.current;
      valid = false;
    } else {
      setEmailError(null);
    }

    if (password.length === 0) {
      setPasswordError(labels.errors.fieldRequired);
      firstInvalid ??= passwordRef.current;
      valid = false;
    } else {
      setPasswordError(null);
    }

    if (firstInvalid) firstInvalid.focus();
    return valid;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setBusy(true);
    try {
      const client = createClient({ baseUrl: resolveApiUrl() });
      const me = await client.storefront.auth.signIn({ email, password });
      // Cache the customerId so customer-scoped calls can attach it as the
      // `x-customer-id` header until the API switches to session-based
      // resolution. `me.customer` is null for staff-only auth users; we
      // still navigate to the account page so the user sees the appropriate
      // empty-state rather than a hard error.
      writeCachedCustomerId(me.customer?.id ?? null);
      window.location.assign(nextHref);
    } catch (err) {
      setFormError(mapApiError(err, labels));
      // Refocus the password field so the user can retry without
      // re-tabbing through the form.
      passwordRef.current?.focus();
      passwordRef.current?.select();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor={emailId} className="t-caption text-muted block">
          {labels.email}
        </label>
        <input
          id={emailId}
          ref={emailRef}
          name="email"
          type="email"
          autoComplete="email"
          // iOS auto-capitalises the first letter of plain inputs, which
          // then fails the email regex check. Explicit `none` together
          // with `spellCheck=false` matches WIG ("disable spellcheck on
          // emails, codes, usernames").
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={emailError !== null}
          aria-describedby={emailError ? `${emailId}-error` : undefined}
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {emailError && (
          <p
            id={`${emailId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {emailError}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor={passwordId} className="t-caption text-muted">
            {labels.password}
          </label>
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            className="t-caption text-muted hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
          >
            {showPassword ? labels.hidePassword : labels.showPassword}
          </button>
        </div>
        <input
          id={passwordId}
          ref={passwordRef}
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          spellCheck={false}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={passwordError !== null}
          aria-describedby={passwordError ? `${passwordId}-error` : undefined}
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {passwordError && (
          <p
            id={`${passwordId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {passwordError}
          </p>
        )}
      </div>

      {formError && (
        <p id={errorId} role="alert" className="t-caption text-danger">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="btn-primary w-full"
      >
        {busy ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}
