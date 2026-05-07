/**
 * Account helpers — small, client-side glue between the SDK and the
 * customer-scoped endpoints.
 *
 * Why this exists:
 *
 *   The storefront authenticates with HTTP-only session cookies, but the
 *   server-side `/storefront/v1/customer/me/*` and `/customer/me/orders/*`
 *   routes still resolve the current customer from an `x-customer-id`
 *   request header (the v0.1 transitional contract). To bridge the two,
 *   the storefront calls `auth.me()` after sign-in and stashes the
 *   returned `customerId` in `localStorage` so subsequent SDK calls can
 *   pass it back as `customerId` (which the SDK forwards as `x-customer-id`).
 *
 *   Once the API replaces the header read with a session lookup, this
 *   module becomes a no-op shim and can be deleted in one go.
 *
 * Storage shape:
 *
 *   `mt.customerId` — the customer ULID, plain string. Already in use by
 *   the legacy CheckoutFlow island, so we keep the same key.
 */
import { createClient, type StorefrontMe } from "@mt-commerce/sdk";
import { resolveApiUrl } from "./api.js";

/** localStorage key used by both this module and the existing CheckoutFlow. */
export const CUSTOMER_ID_STORAGE_KEY = "mt.customerId";

/**
 * Read the cached `customerId`. Returns `null` when unset, when storage
 * is unavailable (private mode, server-side render), or when the value
 * is the empty string.
 */
export function readCachedCustomerId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(CUSTOMER_ID_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Persist or clear the cached `customerId`. Safe in non-browser contexts. */
export function writeCachedCustomerId(customerId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (customerId === null) {
      window.localStorage.removeItem(CUSTOMER_ID_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CUSTOMER_ID_STORAGE_KEY, customerId);
    }
  } catch {
    // Quota exceeded or storage disabled — best-effort, the user can still
    // browse, just without the customer-scoped header on subsequent calls.
  }
}

/**
 * Fetch the current account state through the SDK and side-effect the
 * cached customerId. Returns the canonical `StorefrontMe` shape so the
 * caller can render account state without a second round-trip.
 *
 * Errors propagate — callers decide whether a transport failure should
 * render the anonymous shell or surface a retry. We do NOT swallow the
 * error here because most call sites (account pages) need to distinguish
 * "not signed in" (200 with `user: null`) from "couldn't reach the API".
 */
export async function refreshAccount(): Promise<StorefrontMe> {
  const client = createClient({ baseUrl: resolveApiUrl() });
  const me = await client.storefront.auth.me();
  writeCachedCustomerId(me.customer?.id ?? null);
  return me;
}

/**
 * Build a sign-in URL that brings the user back to the current page after
 * a successful sign-in. Honors the storefront's locale prefix.
 *
 * Why a function and not a string constant:
 *   - The current path is locale-aware (`/sign-in` for id, `/en/sign-in`
 *     for en). Resolving here keeps each call site small.
 *   - The `next` param is URL-encoded; callers passing already-encoded
 *     strings would double-encode if they constructed the URL themselves.
 */
export function buildSignInHref(
  signInBase: string,
  currentPath: string,
): string {
  return `${signInBase}?next=${encodeURIComponent(currentPath)}`;
}

/**
 * Sign out and clear the local cache. Errors are swallowed — a failed
 * sign-out call still warrants clearing the local customerId, so the
 * UI does not keep showing the previous session's data.
 */
export async function signOutAndClear(): Promise<void> {
  const client = createClient({ baseUrl: resolveApiUrl() });
  try {
    await client.storefront.auth.signOut();
  } catch {
    // Best-effort: still clear local state so the next page load is clean.
  }
  writeCachedCustomerId(null);
}
