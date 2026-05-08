/**
 * Pengaturan — admin store settings.
 *
 * Loads the singleton settings via `client.admin.settings.get()` and edits
 * a local form state. Save is one PATCH call that sends only the fields
 * the operator changed.
 *
 * Sections (top to bottom):
 *   - Toko       — store name, default currency, default locale
 *   - Pajak      — default tax rate (Select fed by `client.admin.tax.list`)
 *   - Pengiriman — full Indonesian address pickers (provinsi → kelurahan)
 *                  driven by the storefront regions endpoints, mirroring
 *                  the customer addresses pattern. Postal code, address
 *                  line, contact phone.
 *   - Notifikasi — email + WhatsApp toggles.
 *
 * The save bar is sticky on scroll. Validation runs client-side on submit
 * (required fields, phone format, postal-code format, region chain
 * completeness); server-side validation errors map back to the relevant
 * field via `details.path`. A successful save emits a sonner toast.
 */
import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  api,
  ApiError,
  type StoreSettings,
  type UpdateStoreSettingsInput,
} from "@/lib/api";
import { useTranslator } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

/**
 * Local form shape. We keep nullable id fields as the literal string `""`
 * so the controlled inputs / selects never receive `undefined`. The
 * `toPatch` helper below converts back to `null`/omit at submission.
 */
interface FormState {
  storeName: string;
  defaultCurrency: string;
  defaultLocale: "id" | "en";

  defaultTaxRateId: string; // "" = none

  shippingOriginProvinsiId: string;
  shippingOriginKotaKabupatenId: string;
  shippingOriginKecamatanId: string;
  shippingOriginKelurahanId: string;
  shippingOriginPostalCode: string;
  shippingOriginAddressLine1: string;
  shippingOriginPhone: string;

  notificationEmailEnabled: boolean;
  notificationWhatsappEnabled: boolean;
}

const TAX_RATE_NONE_VALUE = "__none__";

function toFormState(s: StoreSettings): FormState {
  return {
    storeName: s.storeName,
    defaultCurrency: s.defaultCurrency,
    defaultLocale: s.defaultLocale,
    defaultTaxRateId: s.defaultTaxRateId ?? "",
    shippingOriginProvinsiId: s.shippingOriginProvinsiId ?? "",
    shippingOriginKotaKabupatenId: s.shippingOriginKotaKabupatenId ?? "",
    shippingOriginKecamatanId: s.shippingOriginKecamatanId ?? "",
    shippingOriginKelurahanId: s.shippingOriginKelurahanId ?? "",
    shippingOriginPostalCode: s.shippingOriginPostalCode ?? "",
    shippingOriginAddressLine1: s.shippingOriginAddressLine1 ?? "",
    shippingOriginPhone: s.shippingOriginPhone ?? "",
    notificationEmailEnabled: s.notificationEmailEnabled,
    notificationWhatsappEnabled: s.notificationWhatsappEnabled,
  };
}

/**
 * Diff the edited form against the loaded settings and emit a PATCH body
 * that carries ONLY the changed keys. Empty-string ids translate to
 * `null` (clear). Untouched optional strings are omitted.
 *
 * Returning an empty object signals "nothing changed" — the caller short-
 * circuits the mutation in that case.
 */
function toPatch(
  baseline: FormState,
  next: FormState,
): UpdateStoreSettingsInput {
  const patch: UpdateStoreSettingsInput = {};

  if (next.storeName !== baseline.storeName) patch.storeName = next.storeName;
  if (next.defaultCurrency !== baseline.defaultCurrency) {
    patch.defaultCurrency = next.defaultCurrency;
  }
  if (next.defaultLocale !== baseline.defaultLocale) {
    patch.defaultLocale = next.defaultLocale;
  }

  if (next.defaultTaxRateId !== baseline.defaultTaxRateId) {
    patch.defaultTaxRateId =
      next.defaultTaxRateId.length === 0 ? null : next.defaultTaxRateId;
  }

  patchString(
    "shippingOriginProvinsiId",
    baseline.shippingOriginProvinsiId,
    next.shippingOriginProvinsiId,
    patch,
  );
  patchString(
    "shippingOriginKotaKabupatenId",
    baseline.shippingOriginKotaKabupatenId,
    next.shippingOriginKotaKabupatenId,
    patch,
  );
  patchString(
    "shippingOriginKecamatanId",
    baseline.shippingOriginKecamatanId,
    next.shippingOriginKecamatanId,
    patch,
  );
  patchString(
    "shippingOriginKelurahanId",
    baseline.shippingOriginKelurahanId,
    next.shippingOriginKelurahanId,
    patch,
  );
  patchString(
    "shippingOriginPostalCode",
    baseline.shippingOriginPostalCode,
    next.shippingOriginPostalCode,
    patch,
  );
  patchString(
    "shippingOriginAddressLine1",
    baseline.shippingOriginAddressLine1,
    next.shippingOriginAddressLine1,
    patch,
  );
  patchString(
    "shippingOriginPhone",
    baseline.shippingOriginPhone,
    next.shippingOriginPhone,
    patch,
  );

  if (next.notificationEmailEnabled !== baseline.notificationEmailEnabled) {
    patch.notificationEmailEnabled = next.notificationEmailEnabled;
  }
  if (
    next.notificationWhatsappEnabled !== baseline.notificationWhatsappEnabled
  ) {
    patch.notificationWhatsappEnabled = next.notificationWhatsappEnabled;
  }

  return patch;
}

function patchString(
  key: keyof UpdateStoreSettingsInput,
  baseline: string,
  next: string,
  patch: UpdateStoreSettingsInput,
): void {
  if (baseline === next) return;
  // The API accepts `null` to clear; "" → null, anything else → string.
  // We assign through an `unknown` cast because the union of nullable
  // string keys on `UpdateStoreSettingsInput` is wider than what
  // `keyof` can narrow at the call site.
  (patch as Record<string, string | null>)[key] = next.length === 0 ? null : next;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;
const POSTAL_REGEX = /^\d{5}$/;

/**
 * Field-level validation errors keyed by FormState path. The save handler
 * runs this before issuing the PATCH so the user gets immediate feedback;
 * any server-side validation errors that come back are merged into the
 * same map via `details.issues[].path`.
 */
type FieldErrors = Partial<Record<keyof FormState | "regionChain", string>>;

function validate(form: FormState, t: (k: string) => string): FieldErrors {
  const errors: FieldErrors = {};

  if (form.storeName.trim().length === 0) {
    errors.storeName = t("settings.error.required");
  }

  if (form.shippingOriginPhone.length > 0 && !PHONE_REGEX.test(form.shippingOriginPhone)) {
    errors.shippingOriginPhone = t("settings.error.phone");
  }
  if (
    form.shippingOriginPostalCode.length > 0 &&
    !POSTAL_REGEX.test(form.shippingOriginPostalCode)
  ) {
    errors.shippingOriginPostalCode = t("settings.error.postal");
  }

  // Region chain: a child level is only valid if its parents are also
  // selected. This is the same partial-validity rule the customer
  // address form enforces. We allow "all empty" — the merchant may not
  // have configured shipping origin yet.
  const hasProvinsi = form.shippingOriginProvinsiId.length > 0;
  const hasKota = form.shippingOriginKotaKabupatenId.length > 0;
  const hasKec = form.shippingOriginKecamatanId.length > 0;
  const hasKel = form.shippingOriginKelurahanId.length > 0;
  if ((hasKota && !hasProvinsi) || (hasKec && !hasKota) || (hasKel && !hasKec)) {
    errors.regionChain = t("settings.error.region_chain");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SETTINGS_QUERY_KEY = ["admin", "settings"] as const;
const TAX_RATES_QUERY_KEY = ["admin", "tax", "rates", { activeOnly: true }] as const;

export function SettingsPage() {
  const t = useTranslator();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api.admin.settings.get(),
  });

  // Tax rates feed the "default tax rate" Select. We tolerate this query
  // failing — the section just shows a one-line note instead of taking
  // down the whole page.
  const taxRatesQuery = useQuery({
    queryKey: TAX_RATES_QUERY_KEY,
    queryFn: () => api.admin.tax.list({ activeOnly: true }),
  });

  // Local form state, hydrated from the loaded settings on first paint.
  // The baseline is held as a ref so the diff at submission compares
  // against the last-saved snapshot (not the live form).
  const [form, setForm] = React.useState<FormState | null>(null);
  const baselineRef = React.useRef<FormState | null>(null);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  // Hydrate when the query resolves OR when the cache is refreshed after
  // a successful save. We compare by `updatedAt` so an unchanged refetch
  // does not stomp the form mid-edit.
  React.useEffect(() => {
    if (!settingsQuery.data) return;
    const next = toFormState(settingsQuery.data);
    const baseline = baselineRef.current;
    if (
      baseline === null ||
      // Refetch returned a strictly newer row (post-save) — re-hydrate.
      settingsQuery.data.updatedAt.getTime() >
        (baselineSnapshotTimeRef.current ?? 0)
    ) {
      setForm(next);
      baselineRef.current = next;
      baselineSnapshotTimeRef.current = settingsQuery.data.updatedAt.getTime();
    }
  }, [settingsQuery.data]);

  // Tracks the timestamp the baseline reflects so a stale background
  // refetch doesn't overwrite the user's edits.
  const baselineSnapshotTimeRef = React.useRef<number | null>(null);

  const updateMutation = useMutation({
    mutationFn: (patch: UpdateStoreSettingsInput) =>
      api.admin.settings.update(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, updated);
      // Sync the baseline so subsequent diffs are clean. The effect above
      // also runs (cache change) and re-hydrates the form to match.
      const next = toFormState(updated);
      setForm(next);
      baselineRef.current = next;
      baselineSnapshotTimeRef.current = updated.updatedAt.getTime();
      setErrors({});
      toast.success(t("settings.success"));
    },
    onError: (err) => {
      // Map server validation errors back onto the form fields when
      // possible. The API's standard envelope carries `details.issues[]`
      // with a `path` array — we look at the first segment.
      if (err instanceof ApiError && err.code === "validation_error") {
        const next: FieldErrors = {};
        const issues = readIssues(err.details);
        for (const issue of issues) {
          const head = issue.path[0];
          if (head && typeof head === "string") {
            (next as Record<string, string>)[head] = issue.message;
          }
        }
        setErrors(next);
        toast.error(t("settings.error.validation"));
        return;
      }
      toast.error(t("settings.error.server"));
    },
  });

  if (settingsQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("settings.title")}
          </h1>
        </header>
        <Alert variant="destructive">
          <AlertTitle>{t("settings.error.load")}</AlertTitle>
          <AlertDescription>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void settingsQuery.refetch()}
            >
              {t("common.loading")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("settings.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
        </header>
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const handleSave = () => {
    const baseline = baselineRef.current;
    if (!baseline) return;
    const fieldErrors = validate(form, t);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      toast.error(t("settings.error.validation"));
      return;
    }
    setErrors({});
    const patch = toPatch(baseline, form);
    if (Object.keys(patch).length === 0) {
      toast.message(t("settings.no_changes"));
      return;
    }
    updateMutation.mutate(patch);
  };

  const handleDiscard = () => {
    if (baselineRef.current) {
      setForm(baselineRef.current);
      setErrors({});
    }
  };

  return (
    <div className="flex flex-col gap-4 pb-20">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("settings.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </header>

      <StoreSection form={form} errors={errors} onChange={setForm} />
      <TaxSection
        form={form}
        rates={taxRatesQuery.data ?? null}
        loading={taxRatesQuery.isPending}
        loadError={taxRatesQuery.isError}
        onChange={setForm}
      />
      <ShippingSection form={form} errors={errors} onChange={setForm} />
      <NotificationsSection form={form} onChange={setForm} />

      {/* Sticky save bar — pinned to the bottom of the viewport so a long
          form does not bury the call to action. The right padding matches
          the gated layout's content padding. */}
      <div className="sticky bottom-0 -mx-4 mt-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDiscard}
          disabled={updateMutation.isPending}
        >
          {t("settings.discard")}
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? t("settings.saving") : t("settings.save")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SectionProps {
  form: FormState;
  errors?: FieldErrors;
  onChange: React.Dispatch<React.SetStateAction<FormState | null>>;
}

function setField<K extends keyof FormState>(
  set: React.Dispatch<React.SetStateAction<FormState | null>>,
  key: K,
  value: FormState[K],
): void {
  set((prev) => (prev ? { ...prev, [key]: value } : prev));
}

function StoreSection({ form, errors, onChange }: SectionProps) {
  const t = useTranslator();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.section.store.title")}</CardTitle>
        <CardDescription>{t("settings.section.store.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="storeName">{t("settings.field.storeName")}</Label>
          <Input
            id="storeName"
            value={form.storeName}
            onChange={(e) => setField(onChange, "storeName", e.target.value)}
            aria-invalid={errors?.storeName !== undefined}
          />
          {errors?.storeName ? (
            <p className="text-xs text-destructive">{errors.storeName}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultCurrency">
            {t("settings.field.defaultCurrency")}
          </Label>
          <Select
            value={form.defaultCurrency}
            onValueChange={(v) => setField(onChange, "defaultCurrency", v)}
          >
            <SelectTrigger id="defaultCurrency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="IDR">IDR</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("settings.field.defaultCurrency_help")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultLocale">{t("settings.field.defaultLocale")}</Label>
          <Select
            value={form.defaultLocale}
            onValueChange={(v) =>
              setField(onChange, "defaultLocale", v as "id" | "en")
            }
          >
            <SelectTrigger id="defaultLocale" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="id">Bahasa Indonesia</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

interface TaxSectionProps extends SectionProps {
  rates: ReadonlyArray<{ id: string; code: string; name: string; rateBasisPoints: number }> | null;
  loading: boolean;
  loadError: boolean;
}

function TaxSection({ form, rates, loading, loadError, onChange }: TaxSectionProps) {
  const t = useTranslator();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.section.tax.title")}</CardTitle>
        <CardDescription>{t("settings.section.tax.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultTaxRateId">
            {t("settings.field.defaultTaxRate")}
          </Label>
          <Select
            value={
              form.defaultTaxRateId.length === 0
                ? TAX_RATE_NONE_VALUE
                : form.defaultTaxRateId
            }
            onValueChange={(v) =>
              setField(
                onChange,
                "defaultTaxRateId",
                v === TAX_RATE_NONE_VALUE ? "" : v,
              )
            }
            disabled={loading || loadError}
          >
            <SelectTrigger id="defaultTaxRateId" className="w-full">
              <SelectValue
                placeholder={
                  loading
                    ? t("settings.field.defaultTaxRate_loading")
                    : t("settings.field.defaultTaxRate_none")
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TAX_RATE_NONE_VALUE}>
                {t("settings.field.defaultTaxRate_none")}
              </SelectItem>
              {(rates ?? []).map((rate) => (
                <SelectItem key={rate.id} value={rate.id}>
                  {rate.code} — {rate.name} (
                  {(rate.rateBasisPoints / 100).toFixed(2)}%)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {loadError
              ? t("settings.field.defaultTaxRate_load_error")
              : t("settings.field.defaultTaxRate_help")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ShippingSection({ form, errors, onChange }: SectionProps) {
  const t = useTranslator();

  // Region pickers — each level depends on the previous. We reset the
  // child levels when a parent changes so the dropdowns never display
  // stale options (the new parent invalidates the child set).
  const provinsiQuery = useQuery({
    queryKey: ["regions", "provinsi"],
    queryFn: () => api.storefront.regions.provinsi(),
    staleTime: 60 * 60 * 1000, // 1h — region tables change very rarely
  });

  const kotaQuery = useQuery({
    queryKey: ["regions", "kota", form.shippingOriginProvinsiId],
    queryFn: () =>
      api.storefront.regions.kotaKabupaten({
        provinsiId: form.shippingOriginProvinsiId,
      }),
    enabled: form.shippingOriginProvinsiId.length > 0,
    staleTime: 60 * 60 * 1000,
  });

  const kecamatanQuery = useQuery({
    queryKey: ["regions", "kecamatan", form.shippingOriginKotaKabupatenId],
    queryFn: () =>
      api.storefront.regions.kecamatan({
        kotaKabupatenId: form.shippingOriginKotaKabupatenId,
      }),
    enabled: form.shippingOriginKotaKabupatenId.length > 0,
    staleTime: 60 * 60 * 1000,
  });

  const kelurahanQuery = useQuery({
    queryKey: ["regions", "kelurahan", form.shippingOriginKecamatanId],
    queryFn: () =>
      api.storefront.regions.kelurahan({
        kecamatanId: form.shippingOriginKecamatanId,
      }),
    enabled: form.shippingOriginKecamatanId.length > 0,
    staleTime: 60 * 60 * 1000,
  });

  const setRegion = (
    next: Partial<
      Pick<
        FormState,
        | "shippingOriginProvinsiId"
        | "shippingOriginKotaKabupatenId"
        | "shippingOriginKecamatanId"
        | "shippingOriginKelurahanId"
      >
    >,
  ) => {
    onChange((prev) => (prev ? { ...prev, ...next } : prev));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.section.shipping.title")}</CardTitle>
        <CardDescription>
          {t("settings.section.shipping.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <RegionSelect
          id="shippingProvinsi"
          label={t("settings.field.shippingProvinsi")}
          value={form.shippingOriginProvinsiId}
          onValueChange={(v) =>
            setRegion({
              shippingOriginProvinsiId: v,
              // Cascade reset — selecting a new provinsi invalidates
              // every downstream id.
              shippingOriginKotaKabupatenId: "",
              shippingOriginKecamatanId: "",
              shippingOriginKelurahanId: "",
            })
          }
          options={(provinsiQuery.data ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          disabled={provinsiQuery.isPending}
          placeholder={t("settings.field.shipping_select_placeholder")}
        />

        <RegionSelect
          id="shippingKota"
          label={t("settings.field.shippingKota")}
          value={form.shippingOriginKotaKabupatenId}
          onValueChange={(v) =>
            setRegion({
              shippingOriginKotaKabupatenId: v,
              shippingOriginKecamatanId: "",
              shippingOriginKelurahanId: "",
            })
          }
          options={(kotaQuery.data ?? []).map((c) => ({
            value: c.id,
            label: c.name,
          }))}
          disabled={
            form.shippingOriginProvinsiId.length === 0 || kotaQuery.isPending
          }
          placeholder={
            form.shippingOriginProvinsiId.length === 0
              ? t("settings.field.shipping_select_provinsi_first")
              : t("settings.field.shipping_select_placeholder")
          }
        />

        <RegionSelect
          id="shippingKecamatan"
          label={t("settings.field.shippingKecamatan")}
          value={form.shippingOriginKecamatanId}
          onValueChange={(v) =>
            setRegion({
              shippingOriginKecamatanId: v,
              shippingOriginKelurahanId: "",
            })
          }
          options={(kecamatanQuery.data ?? []).map((d) => ({
            value: d.id,
            label: d.name,
          }))}
          disabled={
            form.shippingOriginKotaKabupatenId.length === 0 ||
            kecamatanQuery.isPending
          }
          placeholder={
            form.shippingOriginKotaKabupatenId.length === 0
              ? t("settings.field.shipping_select_kota_first")
              : t("settings.field.shipping_select_placeholder")
          }
        />

        <RegionSelect
          id="shippingKelurahan"
          label={t("settings.field.shippingKelurahan")}
          value={form.shippingOriginKelurahanId}
          onValueChange={(v) => setRegion({ shippingOriginKelurahanId: v })}
          options={(kelurahanQuery.data ?? []).map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          disabled={
            form.shippingOriginKecamatanId.length === 0 ||
            kelurahanQuery.isPending
          }
          placeholder={
            form.shippingOriginKecamatanId.length === 0
              ? t("settings.field.shipping_select_kecamatan_first")
              : t("settings.field.shipping_select_placeholder")
          }
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shippingPostalCode">
            {t("settings.field.shippingPostalCode")}
          </Label>
          <Input
            id="shippingPostalCode"
            inputMode="numeric"
            maxLength={5}
            value={form.shippingOriginPostalCode}
            onChange={(e) =>
              setField(onChange, "shippingOriginPostalCode", e.target.value)
            }
            aria-invalid={errors?.shippingOriginPostalCode !== undefined}
          />
          {errors?.shippingOriginPostalCode ? (
            <p className="text-xs text-destructive">
              {errors.shippingOriginPostalCode}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shippingPhone">
            {t("settings.field.shippingPhone")}
          </Label>
          <Input
            id="shippingPhone"
            value={form.shippingOriginPhone}
            onChange={(e) =>
              setField(onChange, "shippingOriginPhone", e.target.value)
            }
            placeholder="+6281234567890"
            aria-invalid={errors?.shippingOriginPhone !== undefined}
          />
          {errors?.shippingOriginPhone ? (
            <p className="text-xs text-destructive">
              {errors.shippingOriginPhone}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor="shippingAddressLine1">
            {t("settings.field.shippingAddressLine1")}
          </Label>
          <Input
            id="shippingAddressLine1"
            value={form.shippingOriginAddressLine1}
            onChange={(e) =>
              setField(onChange, "shippingOriginAddressLine1", e.target.value)
            }
            aria-invalid={errors?.shippingOriginAddressLine1 !== undefined}
          />
        </div>

        {errors?.regionChain ? (
          <p className="text-xs text-destructive md:col-span-2">
            {errors.regionChain}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NotificationsSection({ form, onChange }: SectionProps) {
  const t = useTranslator();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.section.notifications.title")}</CardTitle>
        <CardDescription>
          {t("settings.section.notifications.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleRow
          id="notificationEmailEnabled"
          label={t("settings.field.notificationEmail")}
          description={t("settings.field.notificationEmail_help")}
          checked={form.notificationEmailEnabled}
          onCheckedChange={(v) =>
            setField(onChange, "notificationEmailEnabled", v)
          }
        />
        <ToggleRow
          id="notificationWhatsappEnabled"
          label={t("settings.field.notificationWhatsapp")}
          description={t("settings.field.notificationWhatsapp_help")}
          checked={form.notificationWhatsappEnabled}
          onCheckedChange={(v) =>
            setField(onChange, "notificationWhatsappEnabled", v)
          }
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small reusable bits
// ---------------------------------------------------------------------------

interface RegionSelectProps {
  id: string;
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  placeholder: string;
}

function RegionSelect(props: RegionSelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select
        value={props.value.length === 0 ? undefined : props.value}
        onValueChange={props.onValueChange}
        disabled={props.disabled}
      >
        <SelectTrigger id={props.id} className="w-full">
          <SelectValue placeholder={props.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface ToggleRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}

function ToggleRow(props: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={props.id} className="cursor-pointer text-sm font-medium">
          {props.label}
        </Label>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Switch
        id={props.id}
        checked={props.checked}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerIssue {
  path: ReadonlyArray<string | number>;
  message: string;
}

/**
 * Defensively read `details.issues` off an `ApiError`. The standard
 * envelope nests these but we pull them out without trusting the shape
 * (callers may receive a non-validation 4xx with a different layout).
 */
function readIssues(details: Record<string, unknown> | undefined): ServerIssue[] {
  if (!details) return [];
  const raw = (details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const path = (entry as { path?: unknown }).path;
      const message = (entry as { message?: unknown }).message;
      if (!Array.isArray(path) || typeof message !== "string") return null;
      return { path: path as ReadonlyArray<string | number>, message };
    })
    .filter((v): v is ServerIssue => v !== null);
}
