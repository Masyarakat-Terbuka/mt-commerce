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
import { useId, useRef, useState } from "react";
import { ApiError, createClient } from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import { writeCachedCustomerId } from "../lib/account.js";

export interface SignUpLabels {
  name: string;
  email: string;
  phone: string;
  phoneHint: string;
  password: string;
  passwordHint: string;
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

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

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

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    name: string | null;
    email: string | null;
    phone: string | null;
    password: string | null;
  }>({ name: null, email: null, phone: null, password: null });

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
    if (phone.trim().length > 0 && !PHONE_REGEX.test(phone.trim())) {
      next.phone = labels.errors.invalidPhone;
      firstInvalid ??= phoneRef.current;
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
      const trimmedPhone = phone.trim();
      const me = await client.storefront.auth.signUp({
        email,
        password,
        name,
        ...(trimmedPhone.length > 0 ? { phone: trimmedPhone } : {}),
      });
      const customerId = me.customer?.id ?? null;
      writeCachedCustomerId(customerId);

      // Better Auth's sign-up does not currently forward the phone field.
      // If the user provided one, patch it onto the customer record now.
      if (trimmedPhone.length > 0 && customerId) {
        try {
          await client.storefront.customer.profile.update(
            { phone: trimmedPhone },
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
    <form
      onSubmit={onSubmit}
      noValidate
      aria-busy={busy}
      className="space-y-5"
    >
      <div className="space-y-2">
        <label htmlFor={nameId} className="block t-caption text-muted">
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
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
        {errors.name && (
          <p id={`${nameId}-error`} role="alert" className="t-caption text-danger">
            {errors.name}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={emailId} className="block t-caption text-muted">
          {labels.email}
        </label>
        <input
          id={emailId}
          ref={emailRef}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email !== null}
          aria-describedby={errors.email ? `${emailId}-error` : undefined}
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
        {errors.email && (
          <p id={`${emailId}-error`} role="alert" className="t-caption text-danger">
            {errors.email}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={phoneId} className="block t-caption text-muted">
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
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
        {errors.phone ? (
          <p id={`${phoneId}-error`} role="alert" className="t-caption text-danger">
            {errors.phone}
          </p>
        ) : (
          <p id={`${phoneId}-hint`} className="t-caption text-faint">
            {labels.phoneHint}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={passwordId} className="block t-caption text-muted">
          {labels.password}
        </label>
        <input
          id={passwordId}
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={errors.password !== null}
          aria-describedby={
            errors.password ? `${passwordId}-error` : `${passwordId}-hint`
          }
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
        {errors.password ? (
          <p
            id={`${passwordId}-error`}
            role="alert"
            className="t-caption text-danger"
          >
            {errors.password}
          </p>
        ) : (
          <p id={`${passwordId}-hint`} className="t-caption text-faint">
            {labels.passwordHint}
          </p>
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
