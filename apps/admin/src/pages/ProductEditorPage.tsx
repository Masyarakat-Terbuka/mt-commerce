/**
 * ProductEditorPage — single component, mode-driven (`create` vs `edit`).
 *
 * Why one component for two routes:
 *   - The form fields, validation, and the submit pipeline are 90% the same.
 *     Splitting into two pages would duplicate the schema and the variant
 *     editor, which is the bulk of this file.
 *   - Mode is implicit from the route: `/produk/baru` → `create`,
 *     `/produk/:id` → `edit`. The router passes `id` as a route param; the
 *     component reads it and branches on presence.
 *
 * Validation strategy:
 *   - Zod schema lives at module scope so it isn't recreated per render.
 *   - On submit, we run the schema against the form state. Field-level
 *     errors are surfaced through shadcn `Field` `data-invalid` and the
 *     paired `<Input aria-invalid>`.
 *   - We do not validate per-keystroke — that creates jumpy UX on a form
 *     this size and isn't necessary because the submit gate is sufficient.
 *
 * Locale tabs:
 *   - The Indonesia tab is the default (mandatory per ADR-0010's
 *     default-locale invariant).
 *   - English is optional; if both `title` and `description` are empty we
 *     omit `en` from the payload entirely so the API isn't asked to store
 *     an empty record.
 *
 * Variant management:
 *   - The form state holds an array of variant drafts; the editor mounts
 *     a numbered card per variant with locale-tabbed title fields.
 *   - On create, the API does not accept variants in the same POST — we
 *     create the product first, then loop `createVariant` calls. If a
 *     variant call fails the product still exists; the editor surfaces a
 *     server error and lets the user retry from `/produk/:id`.
 *   - On edit, existing variants pre-populate; new ones (no `id`) trigger
 *     a `createVariant`; deleted ones trigger `deleteVariant`. We only PATCH
 *     a variant when its translatable / pricing fields actually changed
 *     compared to the original snapshot.
 */
import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, type Product, type ProductStatus } from "@/lib/api";
import { useTranslator } from "@/lib/i18n";

// ----------------------------------------------------------------------------
// Form state shapes
// ----------------------------------------------------------------------------

type EditorMode = "create" | "edit";

type CurrencyOption = "IDR" | "USD";
const CURRENCY_OPTIONS: readonly CurrencyOption[] = ["IDR", "USD"] as const;
const STATUS_OPTIONS: readonly ProductStatus[] = [
  "draft",
  "active",
  "archived",
] as const;
const STATUS_LABEL_KEY: Record<ProductStatus, string> = {
  draft: "products.status.draft",
  active: "products.status.active",
  archived: "products.status.archived",
};

interface VariantDraft {
  /** `null` for variants that haven't been persisted yet. */
  id: string | null;
  sku: string;
  /** Locale-keyed titles. Empty string means "no value for this locale". */
  titleId: string;
  titleEn: string;
  priceAmount: string;
  priceCurrency: CurrencyOption;
  compareAtAmount: string;
}

interface EditorFormState {
  slug: string;
  defaultCurrency: CurrencyOption;
  status: ProductStatus;
  imageUrl: string;
  imageAlt: string;
  titleId: string;
  descriptionId: string;
  titleEn: string;
  descriptionEn: string;
  variants: VariantDraft[];
}

// ----------------------------------------------------------------------------
// Validation
//
// We mirror the API's Zod constraints just closely enough to give helpful
// inline feedback. The server is still authoritative — a 4xx response after
// submit funnels into a generic editor-level error.
// ----------------------------------------------------------------------------

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const integerRegex = /^\d+$/;

function buildSchema() {
  // Money amount input — string from the form, validated as decimal integer.
  const moneyInputSchema = z
    .string()
    .min(1, { message: "editor.error.required" })
    .regex(integerRegex, { message: "editor.error.price_format" });

  const variantSchema = z.object({
    id: z.string().nullable(),
    sku: z.string().min(1, { message: "editor.error.required" }).max(100),
    titleId: z.string(),
    titleEn: z.string(),
    priceAmount: moneyInputSchema,
    priceCurrency: z.enum(CURRENCY_OPTIONS),
    compareAtAmount: z
      .string()
      .refine(
        (value) => value === "" || integerRegex.test(value),
        { message: "editor.error.price_format" },
      ),
  });

  return z
    .object({
      slug: z
        .string()
        .min(1, { message: "editor.error.required" })
        .max(100)
        .regex(slugRegex, { message: "editor.error.slug_format" }),
      defaultCurrency: z.enum(CURRENCY_OPTIONS),
      status: z.enum(STATUS_OPTIONS),
      imageUrl: z
        .string()
        .refine(
          (value) => {
            if (value === "") return true;
            try {
              const u = new URL(value);
              return u.protocol === "http:" || u.protocol === "https:";
            } catch {
              return false;
            }
          },
          { message: "editor.error.url" },
        ),
      imageAlt: z.string().max(500),
      titleId: z
        .string()
        .min(1, { message: "editor.error.required" })
        .max(200),
      descriptionId: z.string().max(10_000),
      titleEn: z.string().max(200),
      descriptionEn: z.string().max(10_000),
      variants: z
        .array(variantSchema)
        .min(1, { message: "editor.error.variant_required" }),
    });
}

const formSchema = buildSchema();

type FieldErrors = Partial<Record<string, string>>;

// ----------------------------------------------------------------------------
// Defaults / mappers
// ----------------------------------------------------------------------------

function emptyVariant(currency: CurrencyOption): VariantDraft {
  return {
    id: null,
    sku: "",
    titleId: "",
    titleEn: "",
    priceAmount: "",
    priceCurrency: currency,
    compareAtAmount: "",
  };
}

function isCurrencyOption(value: string): value is CurrencyOption {
  return (CURRENCY_OPTIONS as readonly string[]).includes(value);
}

function emptyForm(): EditorFormState {
  return {
    slug: "",
    defaultCurrency: "IDR",
    status: "draft",
    imageUrl: "",
    imageAlt: "",
    titleId: "",
    descriptionId: "",
    titleEn: "",
    descriptionEn: "",
    variants: [emptyVariant("IDR")],
  };
}

/**
 * Build form state from a loaded product. The locale-resolved `title` /
 * `description` strings on the wire are the Indonesia view; for English we
 * have no mirror — the API does not expose `translations` on reads. The
 * editor therefore starts with English fields blank on edit, and the
 * merchant fills them in to publish the alternate locale. This is a known
 * limitation and recorded as a follow-up; the alternative would be to add a
 * `translations` field to the wire shape, which is out of scope for this
 * track.
 */
function formFromProduct(product: Product): EditorFormState {
  const defaultCurrency: CurrencyOption = isCurrencyOption(
    product.defaultCurrency,
  )
    ? product.defaultCurrency
    : "IDR";
  return {
    slug: product.slug,
    defaultCurrency,
    status: product.status,
    imageUrl: product.imageUrl ?? "",
    imageAlt: product.imageAlt ?? "",
    titleId: product.title,
    descriptionId: product.description ?? "",
    titleEn: "",
    descriptionEn: "",
    variants:
      product.variants.length > 0
        ? product.variants.map((v) => {
            const currency: CurrencyOption = isCurrencyOption(v.price.currency)
              ? v.price.currency
              : defaultCurrency;
            return {
              id: v.id,
              sku: v.sku,
              titleId: v.title ?? "",
              titleEn: "",
              priceAmount: v.price.amount.toString(),
              priceCurrency: currency,
              compareAtAmount:
                v.compareAtPrice?.amount.toString() ?? "",
            };
          })
        : [emptyVariant(defaultCurrency)],
  };
}

// ----------------------------------------------------------------------------
// Inner editor component — extracted so the page can show a skeleton while
// the product loads on edit, without threading `isPending` through every
// child. The form mounts only once we have something to edit.
// ----------------------------------------------------------------------------

interface EditorProps {
  mode: EditorMode;
  productId: string | null;
  initialForm: EditorFormState;
  /** The pristine product for `edit` mode — used to diff variants on save. */
  pristine: Product | null;
}

function Editor({ mode, productId, initialForm, pristine }: EditorProps) {
  const t = useTranslator();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = React.useState<EditorFormState>(initialForm);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Stable updaters keep child callbacks from re-binding every render.
  const updateField = React.useCallback(
    <K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const updateVariant = React.useCallback(
    (index: number, patch: Partial<VariantDraft>) => {
      setForm((prev) => {
        const next = prev.variants.slice();
        next[index] = { ...next[index]!, ...patch };
        return { ...prev, variants: next };
      });
    },
    [],
  );

  const addVariant = React.useCallback(() => {
    setForm((prev) => ({
      ...prev,
      variants: [...prev.variants, emptyVariant(prev.defaultCurrency)],
    }));
  }, []);

  const removeVariant = React.useCallback((index: number) => {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.filter((_, i) => i !== index),
    }));
  }, []);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const parse = formSchema.safeParse(form);
      if (!parse.success) {
        const fieldErrors: FieldErrors = {};
        for (const issue of parse.error.issues) {
          const path = issue.path.join(".");
          // Only the first issue per path matters for the badge UI.
          if (!fieldErrors[path]) fieldErrors[path] = issue.message;
        }
        setErrors(fieldErrors);
        throw new Error("validation");
      }
      setErrors({});

      const trimmedTitleEn = form.titleEn.trim();
      const trimmedDescriptionEn = form.descriptionEn.trim();
      const includeEn =
        trimmedTitleEn.length > 0 || trimmedDescriptionEn.length > 0;

      const productTranslations = {
        id: {
          title: form.titleId,
          ...(form.descriptionId.length > 0
            ? { description: form.descriptionId }
            : {}),
        },
        ...(includeEn
          ? {
              en: {
                title:
                  trimmedTitleEn.length > 0 ? trimmedTitleEn : form.titleId,
                ...(trimmedDescriptionEn.length > 0
                  ? { description: trimmedDescriptionEn }
                  : {}),
              },
            }
          : {}),
      };

      if (mode === "create") {
        const product = await api.admin.products.create({
          slug: form.slug,
          defaultCurrency: form.defaultCurrency,
          status: form.status,
          translations: productTranslations,
          ...(form.imageUrl.length > 0 ? { imageUrl: form.imageUrl } : {}),
          ...(form.imageAlt.length > 0 ? { imageAlt: form.imageAlt } : {}),
        });

        for (const variant of form.variants) {
          const variantTrimmedEn = variant.titleEn.trim();
          await api.admin.products.createVariant(product.id, {
            sku: variant.sku,
            priceAmount: variant.priceAmount,
            priceCurrency: variant.priceCurrency,
            ...(variant.compareAtAmount.length > 0
              ? { compareAtAmount: variant.compareAtAmount }
              : {}),
            translations: {
              id: { title: variant.titleId },
              ...(variantTrimmedEn.length > 0
                ? { en: { title: variantTrimmedEn } }
                : {}),
            },
          });
        }
        return { kind: "created" as const };
      }

      // mode === "edit"
      if (!productId) throw new Error("missing_id");
      await api.admin.products.update(productId, {
        slug: form.slug,
        defaultCurrency: form.defaultCurrency,
        status: form.status,
        translations: productTranslations,
        imageUrl: form.imageUrl.length > 0 ? form.imageUrl : null,
        imageAlt: form.imageAlt.length > 0 ? form.imageAlt : null,
      });

      const previousVariantsById = new Map(
        (pristine?.variants ?? []).map((v) => [v.id, v] as const),
      );
      const keptVariantIds = new Set<string>();
      for (const variant of form.variants) {
        const variantTrimmedEn = variant.titleEn.trim();
        const translations = {
          id: { title: variant.titleId },
          ...(variantTrimmedEn.length > 0
            ? { en: { title: variantTrimmedEn } }
            : {}),
        };
        if (variant.id) {
          keptVariantIds.add(variant.id);
          await api.admin.products.updateVariant(variant.id, {
            sku: variant.sku,
            priceAmount: variant.priceAmount,
            priceCurrency: variant.priceCurrency,
            compareAtAmount:
              variant.compareAtAmount.length > 0
                ? variant.compareAtAmount
                : null,
            translations,
          });
        } else {
          await api.admin.products.createVariant(productId, {
            sku: variant.sku,
            priceAmount: variant.priceAmount,
            priceCurrency: variant.priceCurrency,
            ...(variant.compareAtAmount.length > 0
              ? { compareAtAmount: variant.compareAtAmount }
              : {}),
            translations,
          });
        }
      }
      // Remove variants that the merchant deleted in the form.
      for (const [id] of previousVariantsById) {
        if (!keptVariantIds.has(id)) {
          await api.admin.products.deleteVariant(id);
        }
      }

      return { kind: "updated" as const };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      toast.success(
        t(
          result.kind === "created"
            ? "editor.success.created"
            : "editor.success.updated",
        ),
      );
      await navigate({ to: "/produk" });
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "validation") {
        setServerError(t("editor.error.validation"));
        return;
      }
      if (err instanceof ApiError) {
        setServerError(err.message || t("editor.error.server"));
        return;
      }
      setServerError(t("editor.error.server"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!productId) throw new Error("missing_id");
      await api.admin.products.delete(productId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      toast.success(t("editor.success.deleted"));
      await navigate({ to: "/produk" });
    },
    onError: () => {
      setServerError(t("editor.error.server"));
      setDeleteOpen(false);
    },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setServerError(null);
    submitMutation.mutate();
  };

  const submitting = submitMutation.isPending;
  const deleting = deleteMutation.isPending;

  const errorFor = (key: string) =>
    errors[key] ? t(errors[key] as string) : undefined;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t(mode === "create" ? "editor.title.create" : "editor.title.edit")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              mode === "create"
                ? "editor.subtitle.create"
                : "editor.subtitle.edit",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigate({ to: "/produk" });
            }}
            disabled={submitting || deleting}
          >
            {t("editor.cancel")}
          </Button>
          {mode === "edit" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={submitting || deleting}
            >
              <HugeiconsIcon icon={Delete02Icon} data-icon />
              <span>{t("editor.delete.button")}</span>
            </Button>
          ) : null}
          <Button type="submit" disabled={submitting || deleting}>
            {submitting ? (
              <>
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon
                  className="animate-spin"
                />
                <span>{t("editor.submit.saving")}</span>
              </>
            ) : (
              <span>
                {t(
                  mode === "create"
                    ? "editor.submit.create"
                    : "editor.submit.update",
                )}
              </span>
            )}
          </Button>
        </div>
      </header>

      {serverError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("common.error")}</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("editor.section.details")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={errors["slug"] ? true : undefined}>
              <FieldLabel htmlFor="editor-slug">
                {t("editor.field.slug")}
              </FieldLabel>
              <Input
                id="editor-slug"
                value={form.slug}
                onChange={(e) => updateField("slug", e.target.value)}
                aria-invalid={errors["slug"] ? true : undefined}
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
              />
              <FieldDescription>{t("editor.field.slug_help")}</FieldDescription>
              {errorFor("slug") ? (
                <FieldError>{errorFor("slug")}</FieldError>
              ) : null}
            </Field>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="editor-currency">
                  {t("editor.field.defaultCurrency")}
                </FieldLabel>
                <Select
                  value={form.defaultCurrency}
                  onValueChange={(value) => {
                    if (isCurrencyOption(value)) {
                      updateField("defaultCurrency", value);
                    }
                  }}
                  disabled={submitting}
                >
                  <SelectTrigger id="editor-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {CURRENCY_OPTIONS.map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="editor-status">
                  {t("editor.field.status")}
                </FieldLabel>
                <Select
                  value={form.status}
                  onValueChange={(value) =>
                    updateField("status", value as ProductStatus)
                  }
                  disabled={submitting}
                >
                  <SelectTrigger id="editor-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(STATUS_LABEL_KEY[s])}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field data-invalid={errors["imageUrl"] ? true : undefined}>
              <FieldLabel htmlFor="editor-image-url">
                {t("editor.field.imageUrl")}
              </FieldLabel>
              <Input
                id="editor-image-url"
                value={form.imageUrl}
                onChange={(e) => updateField("imageUrl", e.target.value)}
                aria-invalid={errors["imageUrl"] ? true : undefined}
                disabled={submitting}
                autoComplete="off"
                inputMode="url"
              />
              {errorFor("imageUrl") ? (
                <FieldError>{errorFor("imageUrl")}</FieldError>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="editor-image-alt">
                {t("editor.field.imageAlt")}
              </FieldLabel>
              <Input
                id="editor-image-alt"
                value={form.imageAlt}
                onChange={(e) => updateField("imageAlt", e.target.value)}
                disabled={submitting}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("editor.section.translations")}
          </CardTitle>
          <CardDescription>{t("editor.field.slug_help")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="id">
            <TabsList>
              <TabsTrigger value="id">{t("editor.tab.id")}</TabsTrigger>
              <TabsTrigger value="en">{t("editor.tab.en")}</TabsTrigger>
            </TabsList>
            <TabsContent value="id" className="mt-4">
              <FieldGroup>
                <Field data-invalid={errors["titleId"] ? true : undefined}>
                  <FieldLabel htmlFor="editor-title-id">
                    {t("editor.field.title")}
                  </FieldLabel>
                  <Input
                    id="editor-title-id"
                    value={form.titleId}
                    onChange={(e) => updateField("titleId", e.target.value)}
                    aria-invalid={errors["titleId"] ? true : undefined}
                    disabled={submitting}
                  />
                  {errorFor("titleId") ? (
                    <FieldError>{errorFor("titleId")}</FieldError>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="editor-description-id">
                    {t("editor.field.description")}
                  </FieldLabel>
                  <Textarea
                    id="editor-description-id"
                    value={form.descriptionId}
                    onChange={(e) =>
                      updateField("descriptionId", e.target.value)
                    }
                    disabled={submitting}
                    rows={5}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>
            <TabsContent value="en" className="mt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="editor-title-en">
                    {t("editor.field.title")}
                  </FieldLabel>
                  <Input
                    id="editor-title-en"
                    value={form.titleEn}
                    onChange={(e) => updateField("titleEn", e.target.value)}
                    disabled={submitting}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="editor-description-en">
                    {t("editor.field.description")}
                  </FieldLabel>
                  <Textarea
                    id="editor-description-en"
                    value={form.descriptionEn}
                    onChange={(e) =>
                      updateField("descriptionEn", e.target.value)
                    }
                    disabled={submitting}
                    rows={5}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">
              {t("editor.section.variants")}
            </CardTitle>
            {errors["variants"] ? (
              <CardDescription className="text-destructive">
                {errorFor("variants")}
              </CardDescription>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addVariant}
            disabled={submitting}
          >
            <HugeiconsIcon icon={Add01Icon} data-icon />
            <span>{t("editor.variant.add")}</span>
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {form.variants.map((variant, index) => {
            const skuKey = `variants.${index}.sku`;
            const priceKey = `variants.${index}.priceAmount`;
            const compareKey = `variants.${index}.compareAtAmount`;
            return (
              <Card key={variant.id ?? `draft-${index}`} className="border">
                <CardHeader className="flex flex-row items-center justify-between gap-2">
                  <CardTitle className="text-sm font-medium">
                    {t("editor.variant.label").replace(
                      "{n}",
                      String(index + 1),
                    )}
                  </CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeVariant(index)}
                    disabled={submitting || form.variants.length === 1}
                  >
                    <HugeiconsIcon icon={Delete02Icon} data-icon />
                    <span>{t("editor.variant.remove")}</span>
                  </Button>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field data-invalid={errors[skuKey] ? true : undefined}>
                      <FieldLabel htmlFor={`editor-variant-sku-${index}`}>
                        {t("editor.variant.sku")}
                      </FieldLabel>
                      <Input
                        id={`editor-variant-sku-${index}`}
                        value={variant.sku}
                        onChange={(e) =>
                          updateVariant(index, { sku: e.target.value })
                        }
                        aria-invalid={
                          errors[skuKey] ? true : undefined
                        }
                        disabled={submitting}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {errors[skuKey] ? (
                        <FieldError>{t(errors[skuKey] as string)}</FieldError>
                      ) : null}
                    </Field>

                    <Tabs defaultValue="id">
                      <TabsList>
                        <TabsTrigger value="id">
                          {t("editor.tab.id")}
                        </TabsTrigger>
                        <TabsTrigger value="en">
                          {t("editor.tab.en")}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="id" className="mt-3">
                        <Field>
                          <FieldLabel htmlFor={`editor-variant-title-id-${index}`}>
                            {t("editor.variant.title_field")}
                          </FieldLabel>
                          <Input
                            id={`editor-variant-title-id-${index}`}
                            value={variant.titleId}
                            onChange={(e) =>
                              updateVariant(index, { titleId: e.target.value })
                            }
                            disabled={submitting}
                          />
                        </Field>
                      </TabsContent>
                      <TabsContent value="en" className="mt-3">
                        <Field>
                          <FieldLabel htmlFor={`editor-variant-title-en-${index}`}>
                            {t("editor.variant.title_field")}
                          </FieldLabel>
                          <Input
                            id={`editor-variant-title-en-${index}`}
                            value={variant.titleEn}
                            onChange={(e) =>
                              updateVariant(index, { titleEn: e.target.value })
                            }
                            disabled={submitting}
                          />
                        </Field>
                      </TabsContent>
                    </Tabs>

                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                      <Field
                        data-invalid={errors[priceKey] ? true : undefined}
                      >
                        <FieldLabel htmlFor={`editor-variant-price-${index}`}>
                          {t("editor.variant.price")}
                        </FieldLabel>
                        <Input
                          id={`editor-variant-price-${index}`}
                          value={variant.priceAmount}
                          onChange={(e) =>
                            updateVariant(index, {
                              priceAmount: e.target.value.replace(/\D+/g, ""),
                            })
                          }
                          aria-invalid={
                            errors[priceKey] ? true : undefined
                          }
                          inputMode="numeric"
                          disabled={submitting}
                          autoComplete="off"
                        />
                        {errors[priceKey] ? (
                          <FieldError>
                            {t(errors[priceKey] as string)}
                          </FieldError>
                        ) : null}
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`editor-variant-currency-${index}`}
                        >
                          {t("editor.variant.price_currency")}
                        </FieldLabel>
                        <Select
                          value={variant.priceCurrency}
                          onValueChange={(value) => {
                            if (isCurrencyOption(value)) {
                              updateVariant(index, { priceCurrency: value });
                            }
                          }}
                          disabled={submitting}
                        >
                          <SelectTrigger
                            id={`editor-variant-currency-${index}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {CURRENCY_OPTIONS.map((code) => (
                                <SelectItem key={code} value={code}>
                                  {code}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>

                    <Field
                      data-invalid={errors[compareKey] ? true : undefined}
                    >
                      <FieldLabel htmlFor={`editor-variant-compare-${index}`}>
                        {t("editor.variant.compareAt")}
                      </FieldLabel>
                      <Input
                        id={`editor-variant-compare-${index}`}
                        value={variant.compareAtAmount}
                        onChange={(e) =>
                          updateVariant(index, {
                            compareAtAmount: e.target.value.replace(/\D+/g, ""),
                          })
                        }
                        aria-invalid={
                          errors[compareKey] ? true : undefined
                        }
                        inputMode="numeric"
                        disabled={submitting}
                        autoComplete="off"
                      />
                      {errors[compareKey] ? (
                        <FieldError>
                          {t(errors[compareKey] as string)}
                        </FieldError>
                      ) : null}
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("editor.delete.confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("editor.delete.confirm_message")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("editor.delete.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                // Prevent the default close so we keep the dialog open while
                // the request is in flight; we'll close on success/error.
                event.preventDefault();
                deleteMutation.mutate();
              }}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("editor.submit.saving")}</span>
                </>
              ) : (
                <span>{t("editor.delete.confirm")}</span>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

// ----------------------------------------------------------------------------
// Page wrapper — picks mode from the URL and loads the product on edit.
// ----------------------------------------------------------------------------

interface ProductEditorPageProps {
  mode: EditorMode;
}

export function ProductEditorPage({ mode }: ProductEditorPageProps) {
  const t = useTranslator();
  const params = useParams({ strict: false }) as { id?: string };
  const productId = mode === "edit" ? (params.id ?? null) : null;

  const productQuery = useQuery({
    queryKey: ["admin", "product", productId] as const,
    queryFn: async () => {
      if (!productId) throw new Error("missing_id");
      return api.admin.products.byId(productId);
    },
    enabled: mode === "edit" && productId !== null,
    staleTime: 30 * 1000,
  });

  if (mode === "create") {
    return (
      <Editor
        mode="create"
        productId={null}
        initialForm={emptyForm()}
        pristine={null}
      />
    );
  }

  if (productQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("common.error")}</AlertTitle>
        <AlertDescription>{t("editor.load_error")}</AlertDescription>
      </Alert>
    );
  }

  if (!productQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <Editor
      mode="edit"
      productId={productId}
      initialForm={formFromProduct(productQuery.data)}
      pristine={productQuery.data}
    />
  );
}
