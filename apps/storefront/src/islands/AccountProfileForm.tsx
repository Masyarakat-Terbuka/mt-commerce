/**
 * AccountProfileForm — edit name, email, and phone for the signed-in customer.
 *
 * Note on email: the API accepts email updates on the customer profile, but
 * Better Auth's auth_users.email is the source of truth for sign-in. Updating
 * the customer email here does NOT propagate to Better Auth — the user would
 * still sign in with the original auth email. Until the auth-side email-change
 * flow lands (with verification), the email field is rendered read-only and
 * the hint flags the limitation.
 *
 * Submission strategy:
 *   - The form computes a diff of changed fields and sends a partial patch.
 *     A no-op submit short-circuits on the client without a round-trip.
 *   - On success, the success notice fades in for ~2.5s. We deliberately do
 *     not toast or modal — the inline notice is calmer and matches the rest
 *     of the storefront's tone.
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  type Customer,
  type StorefrontMe,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";

export interface AccountProfileFormLabels {
  title: string;
  name: string;
  email: string;
  emailHint: string;
  phone: string;
  phoneHint: string;
  submit: string;
  submitting: string;
  saved: string;
  errors: {
    fieldRequired: string;
    invalidPhone: string;
    network: string;
    generic: string;
  };
}

export interface AccountProfileFormProps {
  apiLocale: "id" | "en";
  signInHref: string;
  currentPath: string;
  labels: AccountProfileFormLabels;
}

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

type Phase = "loading" | "ready" | "redirecting" | "error";

function mapApiError(err: unknown, labels: AccountProfileFormLabels): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error" || err.code === "request_timeout") {
      return labels.errors.network;
    }
  }
  return labels.errors.generic;
}

export default function AccountProfileForm({
  apiLocale,
  signInHref,
  currentPath,
  labels,
}: AccountProfileFormProps) {
  const nameId = useId();
  const emailId = useId();
  const phoneId = useId();

  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<StorefrontMe | null>(null);
  const [profile, setProfile] = useState<Customer | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await refreshAccount();
        if (cancelled) return;
        if (!result.user) {
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        setMe(result);
        if (result.customer?.id) {
          const client = createClient({
            baseUrl: resolveApiUrl(),
            locale: apiLocale,
          });
          const fetched = await client.storefront.customer.profile.get({
            customerId: result.customer.id,
          });
          if (cancelled) return;
          setProfile(fetched);
          setName(fetched.displayName ?? result.user.name ?? "");
          setPhone(fetched.phone ?? "");
        } else {
          setName(result.user.name ?? "");
        }
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          writeCachedCustomerId(null);
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiLocale, currentPath, signInHref]);

  // Hide the "saved" notice after a couple of seconds. Avoids a stale
  // success message lingering after the user has moved on.
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setTimeout(() => setSavedAt(null), 2500);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  function validate(): boolean {
    let firstInvalid: HTMLInputElement | null = null;
    let valid = true;

    if (name.trim().length === 0) {
      setNameError(labels.errors.fieldRequired);
      firstInvalid ??= nameRef.current;
      valid = false;
    } else {
      setNameError(null);
    }

    if (phone.trim().length > 0 && !PHONE_REGEX.test(phone.trim())) {
      setPhoneError(labels.errors.invalidPhone);
      firstInvalid ??= phoneRef.current;
      valid = false;
    } else {
      setPhoneError(null);
    }

    if (firstInvalid) firstInvalid.focus();
    return valid;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;
    if (!me?.customer?.id) return;

    // Build a sparse patch — only fields that actually changed travel.
    // The API rejects empty patches, but a no-op submit (zero changes)
    // short-circuits here so the user gets immediate feedback.
    const patch: { displayName?: string | null; phone?: string | null } = {};
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();

    if (trimmedName !== (profile?.displayName ?? me.user?.name ?? "")) {
      patch.displayName = trimmedName.length === 0 ? null : trimmedName;
    }
    if (trimmedPhone !== (profile?.phone ?? "")) {
      patch.phone = trimmedPhone.length === 0 ? null : trimmedPhone;
    }

    if (Object.keys(patch).length === 0) {
      setSavedAt(Date.now());
      return;
    }

    setBusy(true);
    try {
      const client = createClient({
        baseUrl: resolveApiUrl(),
        locale: apiLocale,
      });
      const updated = await client.storefront.customer.profile.update(patch, {
        customerId: me.customer.id,
      });
      setProfile(updated);
      setSavedAt(Date.now());
    } catch (err) {
      setFormError(mapApiError(err, labels));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading" || phase === "redirecting") {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-9 w-72 skeleton" />
        <div className="h-32 w-full skeleton" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="t-display text-fg">{labels.title}</h1>
      </header>

      <form
        onSubmit={onSubmit}
        noValidate
        aria-busy={busy}
        className="max-w-[480px] space-y-6"
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
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? `${nameId}-error` : undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          />
          {nameError && (
            <p id={`${nameId}-error`} role="alert" className="t-caption text-danger">
              {nameError}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor={emailId} className="block t-caption text-muted">
            {labels.email}
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            value={me?.user?.email ?? ""}
            readOnly
            aria-describedby={`${emailId}-hint`}
            className="w-full border border-line bg-cream px-3 py-2 t-body text-muted outline-none"
          />
          <p id={`${emailId}-hint`} className="t-caption text-faint">
            {labels.emailHint}
          </p>
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
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={phoneError !== null}
            aria-describedby={
              phoneError ? `${phoneId}-error` : `${phoneId}-hint`
            }
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          />
          {phoneError ? (
            <p
              id={`${phoneId}-error`}
              role="alert"
              className="t-caption text-danger"
            >
              {phoneError}
            </p>
          ) : (
            <p id={`${phoneId}-hint`} className="t-caption text-faint">
              {labels.phoneHint}
            </p>
          )}
        </div>

        {formError && (
          <p role="alert" className="t-caption text-danger">
            {formError}
          </p>
        )}

        {savedAt !== null && !formError && (
          <p role="status" className="t-caption text-success">
            {labels.saved}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="btn-primary"
        >
          {busy ? labels.submitting : labels.submit}
        </button>
      </form>
    </div>
  );
}
