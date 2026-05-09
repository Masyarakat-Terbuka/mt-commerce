/**
 * SignUpForm — React island that registers a new customer.
 *
 * Same architectural shape as SignInForm: real form semantics, accessible
 * label/error wiring, focus on first invalid field, busy state.
 *
 * Sign-up flow:
 *   1. Submit `{ email, password, name }` to Better Auth.
 *   2. If a `phone` was provided, follow up with a profile patch
 *      (`customer.profile.update({ phone })`). Better Auth's sign-up
 *      payload does not accept phone today, so the SDK keeps the field on
 *      the input shape but does NOT forward it; we patch the customer
 *      record after the auth row exists.
 *   3. Cache the customerId and navigate to `nextHref`.
 *
 * Validation:
 *   - Name and email required.
 *   - Password: at least 12 chars, mixed letters and digits, mirroring the
 *     server-side `passwordSchema` so the user is not surprised by a 422.
 *   - Phone: optional, but when present must look like E.164 (+ optional,
 *     followed by 1-9 then 1-14 digits) — the same regex the API enforces.
 *
 * Error mapping:
 *   - 409 / `email_taken` / Better Auth's `USER_ALREADY_EXISTS` → "email taken".
 *   - 422 / weak password → "weak password".
 *   - Network → "network".
 *   - Anything else → "generic".
 */
import { useId, useMemo, useRef, useState } from "react";
import { ApiError, createClient } from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import { writeCachedCustomerId } from "../lib/account.js";
import { isValidE164, normalizePhone } from "../lib/phone.js";

export interface SignUpLabels {
  name: string;
  email: string;
  phone: string;
  phoneHint: string;
  password: string;
  /**
   * Static one-line hint shown on the password field. Kept for
   * backwards-compat with existing pages even though the live
   * checklist below the field renders the same information more
   * usefully — operators can decide whether to show both or hide the
   * static line by passing an empty string.
   */
  passwordHint: string;
  passwordCheckLength: string;
  passwordCheckLetters: string;
  passwordCheckDigits: string;
  showPassword: string;
  hidePassword: string;
  submit: string;
  submitting: string;
  errors: {
    emailTaken: string;
    weakPassword: string;
    network: string;
    generic: string;
    fieldRequired: string;
    invalidEmail: string;
    invalidPhone: string;
  };
}

export interface SignUpFormProps {
  nextHref: string;
  labels: SignUpLabels;
}

function mapApiError(err: unknown, labels: SignUpLabels): string {
  if (err instanceof ApiError) {
    // Better Auth surfaces "user already exists" as a 422 with code
    // `USER_ALREADY_EXISTS`. Our standard envelope returns 409 with
    // `email_conflict` when the post-sign-up customer creation fails on
    // email uniqueness — both reach this branch.
    const code = err.code.toLowerCase();
    if (
      err.status === 409 ||
      code.includes("already") ||
      code.includes("conflict") ||
      code.includes("taken")
    ) {
      return labels.errors.emailTaken;
    }
    if (
      err.status === 422 ||
      code.includes("weak") ||
      code.includes("password")
    ) {
      return labels.errors.weakPassword;
    }
    if (err.code === "network_error" || err.code === "request_timeout") {
      return labels.errors.network;
    }
  }
  return labels.errors.generic;
}

export default function SignUpForm({ nextHref, labels }: SignUpFormProps) {
  const nameId = useId();
  const emailId = useId();
  const phoneId = useId();
  const passwordId = useId();

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  // Show/Hide password toggle — flips the input's `type` attribute.
  // Default off (mask) so a passing shoulder doesn't catch the password
  // by accident. The toggle is a small text button beside the label, in
  // line with the storefront's quiet visual register.
  const [showPassword, setShowPassword] = useState(false);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    name: string | null;
    email: string | null;
    phone: string | null;
    password: string | null;
  }>({ name: null, email: null, phone: null, password: null });

  // Live checklist for the password field. Three criteria, all required —
  // mirrors the server-side `passwordSchema`. Each entry's `met` flag
  // drives the visible ✓ / · indicator and the colour swap.
  const passwordChecks = useMemo(
    () => [
      {
        key: "length",
        label: labels.passwordCheckLength,
        met: password.length >= 12,
      },
      {
        key: "letters",
        label: labels.passwordCheckLetters,
        met: /[A-Za-z]/.test(password),
      },
      {
        key: "digits",
        label: labels.passwordCheckDigits,
        met: /\d/.test(password),
      },
    ],
    [
      password,
      labels.passwordCheckLength,
      labels.passwordCheckLetters,
      labels.passwordCheckDigits,
    ],
  );

  function validate(): boolean {
    let firstInvalid: HTMLInputElement | null = null;
    const next = { name: null, email: null, phone: null, password: null } as {
      name: string | null;
      email: string | null;
      phone: string | null;
      password: string | null;
    };

    if (name.trim().length === 0) {
      next.name = labels.errors.fieldRequired;
      firstInvalid ??= nameRef.current;
    }
    if (email.trim().length === 0) {
      next.email = labels.errors.fieldRequired;
      firstInvalid ??= emailRef.current;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.email = labels.errors.invalidEmail;
      firstInvalid ??= emailRef.current;
    }
    if (phone.trim().length > 0) {
      // Normalize (e.g. `081234567890` → `+6281234567890`) before checking
      // E.164. Avoids rejecting the form Indonesian shoppers actually type.
      const normalized = normalizePhone(phone);
      if (!isValidE164(normalized)) {
        next.phone = labels.errors.invalidPhone;
        firstInvalid ??= phoneRef.current;
      }
    }
    if (
      password.length < 12 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
    ) {
      next.password = labels.errors.weakPassword;
      firstInvalid ??= passwordRef.current;
    }

    setErrors(next);
    if (firstInvalid) firstInvalid.focus();
    return (
      next.name === null &&
      next.email === null &&
      next.phone === null &&
      next.password === null
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setBusy(true);
    try {
      const client = createClient({ baseUrl: resolveApiUrl() });
      // Always send the normalized phone — the API only knows E.164.
      const normalizedPhone = normalizePhone(phone);
      const me = await client.storefront.auth.signUp({
        email,
        password,
        name,
        ...(normalizedPhone.length > 0 ? { phone: normalizedPhone } : {}),
      });
      const customerId = me.customer?.id ?? null;
      writeCachedCustomerId(customerId);

      // Better Auth's sign-up does not currently forward the phone field.
      // If the user provided one, patch it onto the customer record now.
      if (normalizedPhone.length > 0 && customerId) {
        try {
          await client.storefront.customer.profile.update(
            { phone: normalizedPhone },
            { customerId },
          );
        } catch {
          // Non-fatal — the account is created, the user can update phone
          // later from the profile page. Surfacing an error here would be
          // worse UX than a successful redirect.
        }
      }

      window.location.assign(nextHref);
    } catch (err) {
      setFormError(mapApiError(err, labels));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor={nameId} className="t-caption text-muted block">
          {labels.name}
        </label>
        <input
          id={nameId}
          ref={nameRef}
          name="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name !== null}
          aria-describedby={errors.name ? `${nameId}-error` : undefined}
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {errors.name && (
          <p
            id={`${nameId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {errors.name}
          </p>
        )}
      </div>

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
          // would then fail the email regex check. Explicit `none` plus
          // `spellCheck=false` matches WIG ("disable spellcheck on
          // emails, codes, usernames").
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email !== null}
          aria-describedby={errors.email ? `${emailId}-error` : undefined}
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {errors.email && (
          <p
            id={`${emailId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {errors.email}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={phoneId} className="t-caption text-muted block">
          {labels.phone}
        </label>
        <input
          id={phoneId}
          ref={phoneRef}
          name="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={errors.phone !== null}
          aria-describedby={
            errors.phone ? `${phoneId}-error` : `${phoneId}-hint`
          }
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {errors.phone ? (
          <p
            id={`${phoneId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {errors.phone}
          </p>
        ) : (
          <p id={`${phoneId}-hint`} className="t-caption text-faint">
            {labels.phoneHint}
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
            // Pressed state mirrors the visible eye icon's purpose; we
            // skip the icon since the storefront prefers text affordances.
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
          autoComplete="new-password"
          // `spellCheck=false` because masked passwords can briefly flash
          // through the spellcheck UI on some browsers, and a typed pass
          // shouldn't be red-squiggled.
          spellCheck={false}
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={errors.password !== null}
          aria-describedby={
            errors.password ? `${passwordId}-error` : `${passwordId}-checklist`
          }
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
        {errors.password && (
          <p
            id={`${passwordId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {errors.password}
          </p>
        )}
        {/* Live requirement checklist. Only renders once the user has
            started typing — showing all-failing criteria on an empty
            field would read as nagging. Each criterion flips to a
            success-coloured ✓ when met. */}
        {password.length > 0 && (
          <ul id={`${passwordId}-checklist`} className="t-caption space-y-1">
            {passwordChecks.map((check) => (
              <li
                key={check.key}
                className={
                  check.met
                    ? "text-success flex items-baseline gap-2"
                    : "text-faint flex items-baseline gap-2"
                }
              >
                <span aria-hidden="true">{check.met ? "✓" : "·"}</span>
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {formError && (
        <p role="alert" className="t-caption text-danger">
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
