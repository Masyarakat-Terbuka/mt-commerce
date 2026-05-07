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
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  type AddressKind,
  type City,
  type CustomerAddress,
  type District,
  type MtCommerceClient,
  type Province,
  type Subdistrict,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";

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
  form: AddressFormLabels;
}

export interface AddressFormLabels {
  titleNew: string;
  titleEdit: string;
  kind: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  provinsi: string;
  kotaKabupaten: string;
  kecamatan: string;
  kelurahan: string;
  postalCode: string;
  notes: string;
  isDefaultShipping: string;
  isDefaultBilling: string;
  submitNew: string;
  submitEdit: string;
  submitting: string;
  cancel: string;
  placeholderSelect: string;
  loadingRegions: string;
  errors: {
    fieldRequired: string;
    invalidPhone: string;
    invalidPostalCode: string;
    network: string;
    generic: string;
  };
  kindOptions: { shipping: string; billing: string };
}

export interface AccountAddressesProps {
  apiLocale: "id" | "en";
  signInHref: string;
  currentPath: string;
  labels: AccountAddressesLabels;
}

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;
const POSTAL_REGEX = /^\d{5}$/;

type Phase = "loading" | "ready" | "redirecting" | "error";
type PanelMode = { kind: "list" } | { kind: "new" } | { kind: "edit"; address: CustomerAddress };

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
    try {
      await ensureClient().storefront.customer.addresses.remove(address.id, {
        customerId,
      });
      await refreshList();
    } catch {
      // Inline error surface kept light here — the list view re-renders
      // unchanged, the user can retry. A heavier "could not delete" toast
      // would clash with the storefront's calm tone for an action that is
      // rarely repeated.
    }
  }

  async function onSetDefault(address: CustomerAddress, kind: AddressKind) {
    if (!customerId) return;
    try {
      await ensureClient().storefront.customer.addresses.setDefault(
        address.id,
        { kind },
        { customerId },
      );
      await refreshList();
    } catch {
      // Same posture as delete — keep the list visible, let the user retry.
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
        client={ensureClient()}
        customerId={customerId}
        labels={labels.form}
        onCancel={() => setPanel({ kind: "list" })}
        onSaved={async () => {
          await refreshList();
          setPanel({ kind: "list" });
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

      {addresses.length === 0 ? (
        <p className="t-body text-muted">{labels.empty}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="border border-line bg-paper p-5 t-body text-fg"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="t-body text-fg">{address.recipientName}</p>
                <p className="t-overline text-faint">
                  {address.kind === "shipping"
                    ? labels.kindShipping
                    : labels.kindBilling}
                </p>
              </div>
              <p className="mt-2 t-caption text-muted">
                {[address.addressLine1, address.addressLine2]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <p className="t-caption text-muted">
                {address.kotaKabupatenId} · {address.postalCode}
              </p>
              <p className="t-caption text-faint">{address.phone}</p>

              <div className="mt-3 flex flex-wrap gap-2 t-caption text-muted">
                {address.isDefaultShipping && (
                  <span className="border border-line px-2 py-0.5">
                    {labels.defaultShipping}
                  </span>
                )}
                {address.isDefaultBilling && (
                  <span className="border border-line px-2 py-0.5">
                    {labels.defaultBilling}
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-3 t-caption">
                <button
                  type="button"
                  onClick={() => setPanel({ kind: "edit", address })}
                  className="text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
                >
                  {labels.edit}
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(address)}
                  className="text-muted underline-offset-[4px] transition-colors duration-150 hover:text-danger hover:underline"
                >
                  {labels.delete}
                </button>
                {!address.isDefaultShipping && (
                  <button
                    type="button"
                    onClick={() => void onSetDefault(address, "shipping")}
                    className="text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
                  >
                    {labels.setDefaultShipping}
                  </button>
                )}
                {!address.isDefaultBilling && (
                  <button
                    type="button"
                    onClick={() => void onSetDefault(address, "billing")}
                    className="text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
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

// ---------------------------------------------------------------------------
// Address form — used for both create and edit.
// ---------------------------------------------------------------------------

interface AddressFormPanelProps {
  mode: { kind: "new" } | { kind: "edit"; address: CustomerAddress };
  client: MtCommerceClient;
  customerId: string;
  labels: AddressFormLabels;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

function AddressFormPanel({
  mode,
  client,
  customerId,
  labels,
  onCancel,
  onSaved,
}: AddressFormPanelProps) {
  const isEdit = mode.kind === "edit";
  const initial = isEdit ? mode.address : null;

  const idKind = useId();
  const idRecipient = useId();
  const idPhone = useId();
  const idLine1 = useId();
  const idLine2 = useId();
  const idProv = useId();
  const idKota = useId();
  const idKec = useId();
  const idKel = useId();
  const idPostal = useId();
  const idNotes = useId();

  const [kind, setKind] = useState<AddressKind>(initial?.kind ?? "shipping");
  const [recipientName, setRecipientName] = useState(
    initial?.recipientName ?? "",
  );
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [addressLine1, setAddressLine1] = useState(initial?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(initial?.addressLine2 ?? "");
  const [provinsiId, setProvinsiId] = useState(initial?.provinsiId ?? "");
  const [kotaKabupatenId, setKotaKabupatenId] = useState(
    initial?.kotaKabupatenId ?? "",
  );
  const [kecamatanId, setKecamatanId] = useState(initial?.kecamatanId ?? "");
  const [kelurahanId, setKelurahanId] = useState(initial?.kelurahanId ?? "");
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isDefaultShipping, setIsDefaultShipping] = useState(
    initial?.isDefaultShipping ?? false,
  );
  const [isDefaultBilling, setIsDefaultBilling] = useState(
    initial?.isDefaultBilling ?? false,
  );

  const [provinces, setProvinces] = useState<Province[] | null>(null);
  const [cities, setCities] = useState<City[] | null>(null);
  const [districts, setDistricts] = useState<District[] | null>(null);
  const [subdistricts, setSubdistricts] = useState<Subdistrict[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Load provinces once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.regions.provinsi();
        if (!cancelled) setProvinces(list);
      } catch {
        if (!cancelled) setProvinces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Cities depend on provinsiId. Switching the province clears every
  // downstream selection so the user cannot submit an inconsistent tuple.
  useEffect(() => {
    if (!provinsiId) {
      setCities(null);
      setKotaKabupatenId("");
      setKecamatanId("");
      setKelurahanId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.regions.kotaKabupaten({
          provinsiId,
        });
        if (!cancelled) setCities(list);
      } catch {
        if (!cancelled) setCities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, provinsiId]);

  useEffect(() => {
    if (!kotaKabupatenId) {
      setDistricts(null);
      setKecamatanId("");
      setKelurahanId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.regions.kecamatan({
          kotaKabupatenId,
        });
        if (!cancelled) setDistricts(list);
      } catch {
        if (!cancelled) setDistricts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, kotaKabupatenId]);

  useEffect(() => {
    if (!kecamatanId) {
      setSubdistricts(null);
      setKelurahanId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.regions.kelurahan({
          kecamatanId,
        });
        if (!cancelled) setSubdistricts(list);
      } catch {
        if (!cancelled) setSubdistricts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, kecamatanId]);

  // When the user picks a kelurahan, prefill the postal code from it
  // (one fewer field to type). They can still override it.
  useEffect(() => {
    if (!kelurahanId || !subdistricts) return;
    const match = subdistricts.find((s) => s.id === kelurahanId);
    if (match && postalCode === "") setPostalCode(match.postalCode);
    // intentionally only react to kelurahan changes — we do not want to
    // re-overwrite a user-typed postal code on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kelurahanId]);

  function validate(): boolean {
    const next: Record<string, string | null> = {};
    if (recipientName.trim().length === 0) next.recipientName = labels.errors.fieldRequired;
    if (phone.trim().length === 0) next.phone = labels.errors.fieldRequired;
    else if (!PHONE_REGEX.test(phone.trim())) next.phone = labels.errors.invalidPhone;
    if (addressLine1.trim().length === 0) next.addressLine1 = labels.errors.fieldRequired;
    if (!provinsiId) next.provinsiId = labels.errors.fieldRequired;
    if (!kotaKabupatenId) next.kotaKabupatenId = labels.errors.fieldRequired;
    if (!kecamatanId) next.kecamatanId = labels.errors.fieldRequired;
    if (postalCode.trim().length === 0) next.postalCode = labels.errors.fieldRequired;
    else if (!POSTAL_REGEX.test(postalCode.trim()))
      next.postalCode = labels.errors.invalidPostalCode;

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    const payload = {
      kind,
      isDefaultShipping,
      isDefaultBilling,
      recipientName: recipientName.trim(),
      phone: phone.trim(),
      addressLine1: addressLine1.trim(),
      addressLine2:
        addressLine2.trim().length === 0 ? null : addressLine2.trim(),
      provinsiId,
      kotaKabupatenId,
      kecamatanId,
      kelurahanId: kelurahanId.length === 0 ? null : kelurahanId,
      postalCode: postalCode.trim(),
      notes: notes.trim().length === 0 ? null : notes.trim(),
    } as const;

    setBusy(true);
    try {
      if (isEdit && initial) {
        await client.storefront.customer.addresses.update(
          initial.id,
          payload,
          { customerId },
        );
      } else {
        await client.storefront.customer.addresses.create(payload, {
          customerId,
        });
      }
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(
          err.code === "network_error" || err.code === "request_timeout"
            ? labels.errors.network
            : err.message || labels.errors.generic,
        );
      } else {
        setFormError(labels.errors.generic);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="space-y-8">
      <header>
        <h1 className="t-display text-fg">
          {isEdit ? labels.titleEdit : labels.titleNew}
        </h1>
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={idKind}
          label={labels.kind}
          error={errors.kind ?? null}
        >
          <select
            id={idKind}
            value={kind}
            onChange={(e) => setKind(e.target.value as AddressKind)}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          >
            <option value="shipping">{labels.kindOptions.shipping}</option>
            <option value="billing">{labels.kindOptions.billing}</option>
          </select>
        </Field>

        <Field
          id={idRecipient}
          label={labels.recipientName}
          error={errors.recipientName ?? null}
        >
          <input
            id={idRecipient}
            type="text"
            autoComplete="name"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            aria-invalid={errors.recipientName !== null && errors.recipientName !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          />
        </Field>

        <Field
          id={idPhone}
          label={labels.phone}
          error={errors.phone ?? null}
        >
          <input
            id={idPhone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={errors.phone !== null && errors.phone !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          />
        </Field>

        <Field
          id={idPostal}
          label={labels.postalCode}
          error={errors.postalCode ?? null}
        >
          <input
            id={idPostal}
            type="text"
            inputMode="numeric"
            pattern="\d{5}"
            autoComplete="postal-code"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            aria-invalid={errors.postalCode !== null && errors.postalCode !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          />
        </Field>
      </div>

      <Field
        id={idLine1}
        label={labels.addressLine1}
        error={errors.addressLine1 ?? null}
      >
        <input
          id={idLine1}
          type="text"
          autoComplete="address-line1"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
          aria-invalid={errors.addressLine1 !== null && errors.addressLine1 !== undefined}
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
      </Field>

      <Field id={idLine2} label={labels.addressLine2} error={null}>
        <input
          id={idLine2}
          type="text"
          autoComplete="address-line2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={idProv}
          label={labels.provinsi}
          error={errors.provinsiId ?? null}
        >
          <select
            id={idProv}
            value={provinsiId}
            onChange={(e) => setProvinsiId(e.target.value)}
            aria-invalid={errors.provinsiId !== null && errors.provinsiId !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
          >
            <option value="">
              {provinces === null ? labels.loadingRegions : labels.placeholderSelect}
            </option>
            {provinces?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={idKota}
          label={labels.kotaKabupaten}
          error={errors.kotaKabupatenId ?? null}
        >
          <select
            id={idKota}
            value={kotaKabupatenId}
            onChange={(e) => setKotaKabupatenId(e.target.value)}
            disabled={!provinsiId}
            aria-invalid={errors.kotaKabupatenId !== null && errors.kotaKabupatenId !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg disabled:opacity-50"
          >
            <option value="">
              {!provinsiId
                ? labels.placeholderSelect
                : cities === null
                  ? labels.loadingRegions
                  : labels.placeholderSelect}
            </option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={idKec}
          label={labels.kecamatan}
          error={errors.kecamatanId ?? null}
        >
          <select
            id={idKec}
            value={kecamatanId}
            onChange={(e) => setKecamatanId(e.target.value)}
            disabled={!kotaKabupatenId}
            aria-invalid={errors.kecamatanId !== null && errors.kecamatanId !== undefined}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg disabled:opacity-50"
          >
            <option value="">
              {!kotaKabupatenId
                ? labels.placeholderSelect
                : districts === null
                  ? labels.loadingRegions
                  : labels.placeholderSelect}
            </option>
            {districts?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>

        <Field id={idKel} label={labels.kelurahan} error={null}>
          <select
            id={idKel}
            value={kelurahanId}
            onChange={(e) => setKelurahanId(e.target.value)}
            disabled={!kecamatanId}
            className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg disabled:opacity-50"
          >
            <option value="">
              {!kecamatanId
                ? labels.placeholderSelect
                : subdistricts === null
                  ? labels.loadingRegions
                  : labels.placeholderSelect}
            </option>
            {subdistricts?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field id={idNotes} label={labels.notes} error={null}>
        <textarea
          id={idNotes}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full border border-line bg-paper px-3 py-2 t-body text-fg outline-none transition-colors duration-150 focus:border-fg"
        />
      </Field>

      <fieldset className="space-y-3">
        <label className="flex items-center gap-3 t-body text-fg">
          <input
            type="checkbox"
            checked={isDefaultShipping}
            onChange={(e) => setIsDefaultShipping(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {labels.isDefaultShipping}
        </label>
        <label className="flex items-center gap-3 t-body text-fg">
          <input
            type="checkbox"
            checked={isDefaultBilling}
            onChange={(e) => setIsDefaultBilling(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {labels.isDefaultBilling}
        </label>
      </fieldset>

      {formError && (
        <p role="alert" className="t-caption text-danger">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="btn-primary"
        >
          {busy
            ? labels.submitting
            : isEdit
              ? labels.submitEdit
              : labels.submitNew}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn-secondary"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error: string | null;
  children: React.ReactNode;
}

function Field({ id, label, error, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block t-caption text-muted">
        {label}
      </label>
      {children}
      {error && (
        <p role="alert" className="t-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
