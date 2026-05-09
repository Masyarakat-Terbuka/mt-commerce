/**
 * AddressFormPanel — shared form for create + edit of a customer address.
 *
 * Lives in `islands/lib` because two islands consume it: AccountAddresses
 * (the canonical /account/addresses surface) and CheckoutFlow (embedded
 * into the address step so first-time customers don't have to detour to
 * the account page mid-funnel). Keeping the form in one place avoids the
 * usual drift between checkout and account-area copies of the same UI.
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
 * Save shape: the panel calls the create/update SDK directly, then hands
 * the saved `CustomerAddress` back via `onSaved(saved)`. Callers use the
 * returned address to refresh their list and (in checkout) auto-select
 * the new entry as the active shipping address.
 */
import { useEffect, useId, useState } from "react";
import {
  ApiError,
  type AddressKind,
  type City,
  type CustomerAddress,
  type District,
  type MtCommerceClient,
  type Province,
  type Subdistrict,
} from "@mt-commerce/sdk";
import { isValidE164, normalizePhone } from "../../lib/phone.js";

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

const POSTAL_REGEX = /^\d{5}$/;

export type AddressFormMode =
  | { kind: "new" }
  | { kind: "edit"; address: CustomerAddress };

export interface AddressFormPanelProps {
  mode: AddressFormMode;
  client: MtCommerceClient;
  customerId: string;
  labels: AddressFormLabels;
  onCancel: () => void;
  onSaved: (saved: CustomerAddress) => Promise<void> | void;
  /**
   * Hide the title heading. Useful when the form is embedded inside a
   * surface that already provides a section heading (e.g. the checkout
   * address step).
   */
  hideTitle?: boolean;
}

export function AddressFormPanel({
  mode,
  client,
  customerId,
  labels,
  onCancel,
  onSaved,
  hideTitle,
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
      // Cascade: clearing the upstream selection wipes all dependent
      // selections so the user cannot submit an inconsistent tuple.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // Cascade: see the provinsiId effect above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // Cascade: see the provinsiId effect above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Prefill postal code from the picked kelurahan, but only when the
    // field is still empty so a user-typed value is never clobbered.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match && postalCode === "") setPostalCode(match.postalCode);
    // intentionally only react to kelurahan changes — we do not want to
    // re-overwrite a user-typed postal code on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kelurahanId]);

  function validate(): boolean {
    const next: Record<string, string | null> = {};
    if (recipientName.trim().length === 0)
      next.recipientName = labels.errors.fieldRequired;
    if (phone.trim().length === 0) next.phone = labels.errors.fieldRequired;
    // Normalize Indonesian local form before validating against E.164.
    else if (!isValidE164(normalizePhone(phone)))
      next.phone = labels.errors.invalidPhone;
    if (addressLine1.trim().length === 0)
      next.addressLine1 = labels.errors.fieldRequired;
    if (!provinsiId) next.provinsiId = labels.errors.fieldRequired;
    if (!kotaKabupatenId) next.kotaKabupatenId = labels.errors.fieldRequired;
    if (!kecamatanId) next.kecamatanId = labels.errors.fieldRequired;
    if (postalCode.trim().length === 0)
      next.postalCode = labels.errors.fieldRequired;
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
      // Always send the normalized phone — the API only knows E.164.
      phone: normalizePhone(phone),
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
      const saved =
        isEdit && initial
          ? await client.storefront.customer.addresses.update(
              initial.id,
              payload,
              { customerId },
            )
          : await client.storefront.customer.addresses.create(payload, {
              customerId,
            });
      await onSaved(saved);
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
      {!hideTitle && (
        <header>
          <h1 className="t-display text-fg">
            {isEdit ? labels.titleEdit : labels.titleNew}
          </h1>
        </header>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field id={idKind} label={labels.kind} error={errors.kind ?? null}>
          <select
            id={idKind}
            value={kind}
            onChange={(e) => setKind(e.target.value as AddressKind)}
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
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
            aria-invalid={
              errors.recipientName !== null &&
              errors.recipientName !== undefined
            }
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
          />
        </Field>

        <Field id={idPhone} label={labels.phone} error={errors.phone ?? null}>
          <input
            id={idPhone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={errors.phone !== null && errors.phone !== undefined}
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
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
            aria-invalid={
              errors.postalCode !== null && errors.postalCode !== undefined
            }
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
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
          aria-invalid={
            errors.addressLine1 !== null && errors.addressLine1 !== undefined
          }
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
      </Field>

      <Field id={idLine2} label={labels.addressLine2} error={null}>
        <input
          id={idLine2}
          type="text"
          autoComplete="address-line2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
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
            aria-invalid={
              errors.provinsiId !== null && errors.provinsiId !== undefined
            }
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
          >
            <option value="">
              {provinces === null
                ? labels.loadingRegions
                : labels.placeholderSelect}
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
            aria-invalid={
              errors.kotaKabupatenId !== null &&
              errors.kotaKabupatenId !== undefined
            }
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none disabled:opacity-50"
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
            aria-invalid={
              errors.kecamatanId !== null && errors.kecamatanId !== undefined
            }
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none disabled:opacity-50"
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
            className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none disabled:opacity-50"
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
          className="border-line bg-paper t-body text-fg focus:border-fg w-full border px-3 py-2 transition-colors duration-150 outline-none"
        />
      </Field>

      <fieldset className="space-y-3">
        <label className="t-body text-fg flex items-center gap-3">
          <input
            type="checkbox"
            checked={isDefaultShipping}
            onChange={(e) => setIsDefaultShipping(e.target.checked)}
            className="accent-accent h-4 w-4"
          />
          {labels.isDefaultShipping}
        </label>
        <label className="t-body text-fg flex items-center gap-3">
          <input
            type="checkbox"
            checked={isDefaultBilling}
            onChange={(e) => setIsDefaultBilling(e.target.checked)}
            className="accent-accent h-4 w-4"
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
      <label htmlFor={id} className="t-caption text-muted block">
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
