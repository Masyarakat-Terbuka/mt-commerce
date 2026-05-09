/**
 * AccountAddresses — list, create, edit, and delete the customer's addresses.
 *
 * Single island so the create/edit form can share the address-list state
 * without prop-drilling through multiple components. The form is a child
 * subcomponent (`AddressFormPanel`) toggled by the list view's actions.
 *
 * Indonesian regions:
 *
 *   The form drives four cascading dropdowns (provinsi → kota/kabupaten
 *   → kecamatan → kelurahan). Each level fetches its options when its
 *   parent's selection changes; switching a parent clears every
 *   downstream selection so the user cannot land on an inconsistent
 *   tuple. Postal code falls out of the kelurahan choice but stays
 *   editable since some users know the code by heart.
 *
 * Cross-tenant safety lives on the server (the API returns 404 for any
 * address that is not yours); this island assumes its `customerId` is
 * authoritative and never re-checks ownership at the UI layer.
 */
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  type AddressKind,
  type CustomerAddress,
  type MtCommerceClient,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";
import {
  AddressFormPanel,
  type AddressFormLabels,
} from "./lib/AddressFormPanel.js";

export type { AddressFormLabels };

export interface AccountAddressesLabels {
  title: string;
  empty: string;
  addNew: string;
  edit: string;
  delete: string;
  deleteConfirm: string;
  setDefaultShipping: string;
  setDefaultBilling: string;
  defaultShipping: string;
  defaultBilling: string;
  kindShipping: string;
  kindBilling: string;
  loading: string;
  error: string;
  /** Polite live-region announcement after a successful save. */
  saveSuccess: string;
  /** Polite live-region announcement after a successful delete. */
  deleteSuccess: string;
  /** Inline error shown when set-default fails — pairs with role="alert". */
  actionError: string;
  form: AddressFormLabels;
}

export interface AccountAddressesProps {
  apiLocale: "id" | "en";
  signInHref: string;
  currentPath: string;
  labels: AccountAddressesLabels;
}

type Phase = "loading" | "ready" | "redirecting" | "error";
type PanelMode =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "edit"; address: CustomerAddress };

export default function AccountAddresses({
  apiLocale,
  signInHref,
  currentPath,
  labels,
}: AccountAddressesProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [panel, setPanel] = useState<PanelMode>({ kind: "list" });
  // Polite live-region message — announced after save/delete so a screen
  // reader user gets confirmation that the silent state change worked.
  // Sighted users see the list update; this just covers the a11y gap.
  const [statusMessage, setStatusMessage] = useState<string>("");
  // Surfaces a calm inline message when an action (delete or set-default)
  // fails. Previous behavior swallowed the error silently — fine when
  // the user can re-click and try again, but invisible failure on a
  // default-changing action breaks trust. The list view stays mounted
  // so the user can retry without losing context.
  const [actionError, setActionError] = useState<string | null>(null);
  const clientRef = useRef<MtCommerceClient | null>(null);

  function ensureClient(): MtCommerceClient {
    if (!clientRef.current) {
      clientRef.current = createClient({
        baseUrl: resolveApiUrl(),
        locale: apiLocale,
      });
    }
    return clientRef.current;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await refreshAccount();
        if (cancelled) return;
        if (!me.user) {
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        if (!me.customer?.id) {
          setPhase("error");
          return;
        }
        setCustomerId(me.customer.id);
        const list = await ensureClient().storefront.customer.addresses.list({
          customerId: me.customer.id,
        });
        if (cancelled) return;
        setAddresses(list);
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
    // ensureClient is stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiLocale, currentPath, signInHref]);

  async function refreshList() {
    if (!customerId) return;
    const list = await ensureClient().storefront.customer.addresses.list({
      customerId,
    });
    setAddresses(list);
  }

  async function onDelete(address: CustomerAddress) {
    if (!customerId) return;
    if (!window.confirm(labels.deleteConfirm)) return;
    setActionError(null);
    try {
      await ensureClient().storefront.customer.addresses.remove(address.id, {
        customerId,
      });
      await refreshList();
      setStatusMessage(labels.deleteSuccess);
    } catch {
      // The list re-renders unchanged so the user can retry. We surface a
      // calm inline error (rather than a toast) so the failure is at least
      // visible — the previous silent-swallow broke trust on a destructive
      // action.
      setActionError(labels.actionError);
    }
  }

  async function onSetDefault(address: CustomerAddress, kind: AddressKind) {
    if (!customerId) return;
    setActionError(null);
    try {
      await ensureClient().storefront.customer.addresses.setDefault(
        address.id,
        { kind },
        { customerId },
      );
      await refreshList();
      setStatusMessage(labels.saveSuccess);
    } catch {
      // Surface the failure inline — see onDelete for rationale.
      setActionError(labels.actionError);
    }
  }

  if (phase === "loading" || phase === "redirecting") {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="skeleton h-9 w-72" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (phase === "error" || !customerId) {
    return (
      <div className="space-y-6">
        <p role="alert" className="t-body text-danger">
          {labels.error}
        </p>
      </div>
    );
  }

  if (panel.kind === "new" || panel.kind === "edit") {
    return (
      <AddressFormPanel
        mode={panel}
        // ensureClient() lazy-creates a stable client on first call; the
        // ref access here is benign because it is idempotent and does
        // not influence the render tree.
        // eslint-disable-next-line react-hooks/refs
        client={ensureClient()}
        customerId={customerId}
        labels={labels.form}
        onCancel={() => setPanel({ kind: "list" })}
        onSaved={async () => {
          await refreshList();
          setPanel({ kind: "list" });
          setStatusMessage(labels.saveSuccess);
        }}
      />
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="t-display text-fg">{labels.title}</h1>
        <button
          type="button"
          onClick={() => setPanel({ kind: "new" })}
          className="btn-secondary"
        >
          {labels.addNew}
        </button>
      </header>

      {/*
       * Polite live region — sighted users see the list update; this
       * announces the silent state change for screen readers. Empty
       * string between announcements so the same message can fire twice.
       */}
      <p role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </p>

      {/* Visible inline error surface for failed actions (delete /
          set-default). Calm, single-line, dismissable by retrying. */}
      {actionError && (
        <p role="alert" className="t-caption text-danger">
          {actionError}
        </p>
      )}

      {addresses.length === 0 ? (
        <p className="t-body text-muted">{labels.empty}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="border-line bg-paper t-body text-fg border p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="t-body text-fg">{address.recipientName}</p>
                <p className="t-overline text-faint">
                  {address.kind === "shipping"
                    ? labels.kindShipping
                    : labels.kindBilling}
                </p>
              </div>
              <p className="t-caption text-muted mt-2">
                {[address.addressLine1, address.addressLine2]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              {/*
               * Resolved region names land alongside the BPS ids when the
               * API has them (the customer-address read path JOINs the four
               * region tables). The `?? <id>` fall-back keeps the layout
               * stable against an older API or a stale region FK — the
               * raw code is at least debuggable, and the storefront
               * never blanks out the address line.
               */}
              <p className="t-caption text-muted">
                {[
                  address.kelurahanName ?? address.kelurahanId,
                  address.kecamatanName ?? address.kecamatanId,
                  address.kotaKabupatenName ?? address.kotaKabupatenId,
                  address.provinsiName ?? address.provinsiId,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <p className="t-caption text-muted">{address.postalCode}</p>
              <p className="t-caption text-faint">{address.phone}</p>

              <div className="t-caption text-muted mt-3 flex flex-wrap gap-2">
                {address.isDefaultShipping && (
                  <span className="border-line border px-2 py-0.5">
                    {labels.defaultShipping}
                  </span>
                )}
                {address.isDefaultBilling && (
                  <span className="border-line border px-2 py-0.5">
                    {labels.defaultBilling}
                  </span>
                )}
              </div>

              <div className="t-caption mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setPanel({ kind: "edit", address })}
                  className="text-muted hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
                >
                  {labels.edit}
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(address)}
                  className="text-muted hover:text-danger underline-offset-[4px] transition-colors duration-150 hover:underline"
                >
                  {labels.delete}
                </button>
                {!address.isDefaultShipping && (
                  <button
                    type="button"
                    onClick={() => void onSetDefault(address, "shipping")}
                    className="text-muted hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
                  >
                    {labels.setDefaultShipping}
                  </button>
                )}
                {!address.isDefaultBilling && (
                  <button
                    type="button"
                    onClick={() => void onSetDefault(address, "billing")}
                    className="text-muted hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
                  >
                    {labels.setDefaultBilling}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
