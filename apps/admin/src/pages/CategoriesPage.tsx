/**
 * Kategori — admin categories CRUD.
 *
 * Layout choice — flat table over an indented tree:
 *   The categories table is a 1-level-deep self-referencing hierarchy
 *   (`onDelete: set null` on parent_id, see `apps/api/src/db/schema/categories.ts`).
 *   At v0.1 the data set is small but flat-shaped: most stores will have a
 *   handful of top-level categories with a single layer of children. A
 *   dedicated "Parent" column gives the operator the same information that
 *   indentation would convey, but keeps the page mechanically identical to
 *   the rest of the admin (sortable headers, predictable cell alignment, no
 *   collapse/expand state). Indentation buys you visibility into deep
 *   hierarchies; a flat table buys you searchability and consistency, and
 *   the latter is the right trade for this taxonomy.
 *
 * Data shape:
 *   The admin SDK exposes `client.admin.categories.list()` as a flat array
 *   (no pagination). We sort client-side by parent grouping then by name so
 *   parent rows sit next to their children, which gives the table some
 *   visual hierarchy without committing to an indented control. The same
 *   query feeds both the table and the parent picker in the editor dialog.
 *
 * Mutations:
 *   Create / update / delete go through `useMutation` with cache
 *   invalidation on success — the same pattern used in `ProductEditorPage`
 *   and `InventoryPage`. Toast feedback is non-blocking; the visible
 *   confirmation is the row showing up (or disappearing) in the list.
 *
 * Dialog vs Sheet:
 *   The editor is small (slug + name + parent + description) so a Dialog
 *   keeps the spatial focus tight. A Sheet would force the user to
 *   reorient, which is the wrong cost when the form fits on one screen.
 *
 * Delete behavior:
 *   The schema uses `ON DELETE SET NULL` for `parent_id`, so deleting a
 *   parent silently orphans its children rather than refusing. The API
 *   mirrors that — no validation, no 409. We surface the orphaning fact
 *   to the operator through an in-dialog warning when children exist, but
 *   we still allow the action because that is what the server will do.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Edit02Icon,
  Delete02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { api, ApiError, type Category } from "@/lib/api";
import { useTranslator } from "@/lib/i18n";

const CATEGORIES_QUERY_KEY = ["admin", "categories"] as const;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARENT_NONE_VALUE = "__none__";

/**
 * Tiny debounce hook — same shape as the one in ProductsPage / CustomersPage.
 * Keeping a local copy avoids cross-page coupling for a 6-line utility.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Sort categories so children appear directly under their parent. The flat
 * table doesn't indent — the ordering is what gives the operator a sense of
 * grouping. Top-level rows come first (alphabetical), each followed by its
 * own children (also alphabetical).
 *
 * Orphaned categories (parent_id pointing at a row not in the list, which
 * can happen mid-mutation) fall back into the top-level group rather than
 * disappearing.
 */
function groupForDisplay(categories: Category[]): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c] as const));
  const childrenByParent = new Map<string | null, Category[]>();
  for (const cat of categories) {
    const parentKey = cat.parentId && byId.has(cat.parentId) ? cat.parentId : null;
    const bucket = childrenByParent.get(parentKey) ?? [];
    bucket.push(cat);
    childrenByParent.set(parentKey, bucket);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const ordered: Category[] = [];
  for (const top of childrenByParent.get(null) ?? []) {
    ordered.push(top);
    for (const child of childrenByParent.get(top.id) ?? []) {
      ordered.push(child);
    }
  }
  return ordered;
}

/**
 * Compute the set of category IDs that the editor must NOT offer as a
 * parent: the category itself plus every descendant. Single-parent schema
 * means transitive descendants are reachable by repeated lookup.
 */
function descendantIdsOf(
  categoryId: string,
  categories: Category[],
): Set<string> {
  const result = new Set<string>([categoryId]);
  let frontier: string[] = [categoryId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cat of categories) {
      if (cat.parentId && frontier.includes(cat.parentId) && !result.has(cat.id)) {
        result.add(cat.id);
        next.push(cat.id);
      }
    }
    frontier = next;
  }
  return result;
}

export function CategoriesPage() {
  const t = useTranslator();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = React.useState("");
  const debouncedSearch = useDebouncedValue(searchInput.trim().toLowerCase(), 300);

  const [editorState, setEditorState] = React.useState<EditorState>({
    open: false,
    target: null,
  });
  const [deleteTarget, setDeleteTarget] = React.useState<Category | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => api.admin.categories.list(),
  });

  const categories = data ?? [];

  // Filter on debounced lowercase search. We match either the localized
  // name or the slug — both are short fields the operator might recall.
  const filtered = React.useMemo(() => {
    if (debouncedSearch.length === 0) return categories;
    return categories.filter(
      (c) =>
        c.name.toLowerCase().includes(debouncedSearch) ||
        c.slug.toLowerCase().includes(debouncedSearch),
    );
  }, [categories, debouncedSearch]);

  const ordered = React.useMemo(() => groupForDisplay(filtered), [filtered]);

  // Map id -> category once so the table's "Parent" cell is an O(1) lookup
  // per row, not a linear scan. Also used by the editor for the "exclude
  // self+descendants" computation.
  const byId = React.useMemo(
    () => new Map(categories.map((c) => [c.id, c] as const)),
    [categories],
  );

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.admin.categories.delete(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
      // Products carry `categoryIds`; invalidating their list keeps any
      // category-filtered view in sync after a delete.
      await queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      toast.success(t("categories.delete.success"));
      setDeleteTarget(null);
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.message
          ? err.message
          : t("categories.delete.error");
      toast.error(message);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("categories.list_title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("categories.list_subhead")}
          </p>
        </div>
        <Button onClick={() => setEditorState({ open: true, target: null })}>
          <HugeiconsIcon icon={Add01Icon} data-icon />
          <span>{t("categories.action.add")}</span>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={t("categories.search_placeholder")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-7 w-full max-w-xs"
          aria-label={t("categories.search_placeholder")}
        />
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("categories.error.title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("categories.error.body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("categories.error.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!isError ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("categories.columns.name")}</TableHead>
                <TableHead className="w-56">
                  {t("categories.columns.slug")}
                </TableHead>
                <TableHead className="w-56">
                  {t("categories.columns.parent")}
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">
                    {t("categories.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 5 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-28" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-20" />
                    </TableCell>
                  </TableRow>
                ))
              ) : ordered.length > 0 ? (
                ordered.map((category) => {
                  const parent = category.parentId
                    ? byId.get(category.parentId)
                    : null;
                  return (
                    <TableRow key={category.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {/* The leading marker gives a hint of grouping
                              without committing to indentation. */}
                          {parent ? (
                            <span
                              aria-hidden="true"
                              className="text-muted-foreground/50"
                            >
                              ↳
                            </span>
                          ) : null}
                          <span className="font-medium">{category.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {category.slug}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {parent ? (
                          parent.name
                        ) : (
                          <span className="italic">
                            {t("categories.dialog.parent_none")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setEditorState({ open: true, target: category })
                            }
                            aria-label={`${t("categories.action.edit")} — ${category.name}`}
                          >
                            <HugeiconsIcon icon={Edit02Icon} data-icon />
                            <span className="sr-only sm:not-sr-only">
                              {t("categories.action.edit")}
                            </span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteTarget(category)}
                            aria-label={`${t("categories.action.delete")} — ${category.name}`}
                          >
                            <HugeiconsIcon icon={Delete02Icon} data-icon />
                            <span className="sr-only">
                              {t("categories.action.delete")}
                            </span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("categories.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("categories.empty.body")}
                        </EmptyDescription>
                      </EmptyHeader>
                      <Button
                        variant="outline"
                        className="mt-3"
                        onClick={() =>
                          setEditorState({ open: true, target: null })
                        }
                      >
                        <HugeiconsIcon icon={Add01Icon} data-icon />
                        <span>{t("categories.action.add")}</span>
                      </Button>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <CategoryEditorDialog
        open={editorState.open}
        target={editorState.target}
        categories={categories}
        onClose={() => setEditorState({ open: false, target: null })}
      />

      <DeleteDialog
        target={deleteTarget}
        categories={categories}
        isDeleting={deleteMutation.isPending}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Editor dialog — create or edit. Plain controlled state matches the rest of
// the admin (no react-hook-form anywhere in this app).
// ----------------------------------------------------------------------------

interface EditorState {
  open: boolean;
  /** Null = create mode. */
  target: Category | null;
}

interface CategoryEditorDialogProps {
  open: boolean;
  target: Category | null;
  categories: Category[];
  onClose: () => void;
}

interface FormState {
  slug: string;
  nameId: string;
  nameEn: string;
  description: string;
  parentId: string | null;
}

type FieldErrors = Partial<Record<"slug" | "nameId" | "nameEn" | "parentId", string>>;

function emptyForm(): FormState {
  return {
    slug: "",
    nameId: "",
    nameEn: "",
    description: "",
    parentId: null,
  };
}

function formFromCategory(category: Category): FormState {
  return {
    slug: category.slug,
    nameId: category.name,
    nameEn: "",
    description: "",
    parentId: category.parentId,
  };
}

function CategoryEditorDialog({
  open,
  target,
  categories,
  onClose,
}: CategoryEditorDialogProps) {
  const t = useTranslator();
  const queryClient = useQueryClient();

  const isEditMode = target !== null;

  const [form, setForm] = React.useState<FormState>(() =>
    target ? formFromCategory(target) : emptyForm(),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Reset form state when the dialog opens or switches to a different
  // target. Per `vercel-react-best-practices/rerender-derived-state-no-effect`,
  // we compare a key against the previous render and set state during
  // render — no useEffect cascade, change observed in the same paint.
  const triggerKey = open ? `open:${target?.id ?? "__new__"}` : "closed";
  const [lastTriggerKey, setLastTriggerKey] = React.useState(triggerKey);
  if (lastTriggerKey !== triggerKey) {
    setLastTriggerKey(triggerKey);
    if (open) {
      setForm(target ? formFromCategory(target) : emptyForm());
      setErrors({});
      setServerError(null);
    }
  }

  // Self + descendants must not appear as parent options in edit mode. In
  // create mode the new category has no id yet so every category is a valid
  // parent.
  const excludedIds = React.useMemo(() => {
    if (!target) return new Set<string>();
    return descendantIdsOf(target.id, categories);
  }, [target, categories]);

  const parentOptions = React.useMemo(
    () =>
      categories
        .filter((c) => !excludedIds.has(c.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categories, excludedIds],
  );

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (form.nameId.trim().length === 0) {
      next.nameId = t("categories.error.required");
    }
    const slug = form.slug.trim();
    if (slug.length === 0) {
      next.slug = t("categories.error.required");
    } else if (!SLUG_PATTERN.test(slug)) {
      next.slug = t("categories.error.slug_format");
    }
    return next;
  }

  const submitMutation = useMutation({
    mutationFn: async () => {
      const validation = validate();
      if (Object.keys(validation).length > 0) {
        setErrors(validation);
        throw new Error("validation");
      }
      setErrors({});

      const trimmedNameId = form.nameId.trim();
      const trimmedNameEn = form.nameEn.trim();
      const slug = form.slug.trim();
      const parentId = form.parentId ?? null;

      const translations = {
        id: { name: trimmedNameId },
        ...(trimmedNameEn.length > 0
          ? { en: { name: trimmedNameEn } }
          : {}),
      };

      if (isEditMode && target) {
        return await api.admin.categories.update(target.id, {
          slug,
          translations,
          parentId,
        });
      }
      return await api.admin.categories.create({
        slug,
        translations,
        ...(parentId ? { parentId } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
      // Products embed category names indirectly via `categoryIds`; refresh
      // the products list so any category-filtered view stays accurate.
      await queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      toast.success(
        t(
          isEditMode
            ? "categories.dialog.success.updated"
            : "categories.dialog.success.created",
        ),
      );
      onClose();
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "validation") {
        setServerError(t("categories.error.validation"));
        return;
      }
      if (err instanceof ApiError) {
        // Map server-side validation field errors back onto the inputs when
        // the API surfaces them in `details`. The standard envelope (see
        // `packages/sdk/src/errors.ts`) uses `details` with arbitrary keys;
        // the catalog routes return field paths like "slug" or "parentId".
        const fieldErrors: FieldErrors = {};
        const details = err.details;
        if (typeof details === "object" && details !== null) {
          for (const key of ["slug", "parentId"] as const) {
            const v = (details as Record<string, unknown>)[key];
            if (typeof v === "string") {
              fieldErrors[key] = v;
            }
          }
        }
        if (Object.keys(fieldErrors).length > 0) {
          setErrors((prev) => ({ ...prev, ...fieldErrors }));
        }
        setServerError(err.message || t("categories.error.server"));
        return;
      }
      setServerError(t("categories.error.server"));
    },
  });

  const submitting = submitMutation.isPending;

  function handleOpenChange(next: boolean) {
    if (submitting && !next) return;
    if (!next) onClose();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    submitMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {t(
                isEditMode
                  ? "categories.dialog.edit_title"
                  : "categories.dialog.create_title",
              )}
            </DialogTitle>
            <DialogDescription>
              {t("categories.dialog.subhead")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="cat-name-id">
                {t("categories.dialog.name")}
              </Label>
              <Input
                id="cat-name-id"
                value={form.nameId}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, nameId: e.target.value }));
                  if (errors.nameId) {
                    setErrors((prev) => ({ ...prev, nameId: undefined }));
                  }
                }}
                aria-invalid={errors.nameId !== undefined}
                aria-describedby={
                  errors.nameId ? "cat-name-id-error" : undefined
                }
                disabled={submitting}
                required
                autoFocus
                maxLength={200}
              />
              {errors.nameId ? (
                <p
                  id="cat-name-id-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {errors.nameId}
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="cat-name-en">
                {t("categories.dialog.name_en")}
              </Label>
              <Input
                id="cat-name-en"
                value={form.nameEn}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, nameEn: e.target.value }))
                }
                aria-describedby="cat-name-en-help"
                disabled={submitting}
                maxLength={200}
              />
              <p id="cat-name-en-help" className="text-xs text-muted-foreground">
                {t("categories.dialog.name_en_help")}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="cat-slug">
                {t("categories.dialog.slug")}
              </Label>
              <Input
                id="cat-slug"
                value={form.slug}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, slug: e.target.value }));
                  if (errors.slug) {
                    setErrors((prev) => ({ ...prev, slug: undefined }));
                  }
                }}
                aria-invalid={errors.slug !== undefined}
                aria-describedby={
                  errors.slug ? "cat-slug-error" : "cat-slug-help"
                }
                disabled={submitting}
                required
                maxLength={100}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {errors.slug ? (
                <p
                  id="cat-slug-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {errors.slug}
                </p>
              ) : (
                <p id="cat-slug-help" className="text-xs text-muted-foreground">
                  {t("categories.dialog.slug_help")}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="cat-parent">
                {t("categories.dialog.parent")}
              </Label>
              <Select
                value={form.parentId ?? PARENT_NONE_VALUE}
                onValueChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    parentId:
                      value === PARENT_NONE_VALUE ? null : value,
                  }))
                }
                disabled={submitting}
              >
                <SelectTrigger
                  id="cat-parent"
                  aria-invalid={errors.parentId !== undefined}
                >
                  <SelectValue
                    placeholder={t("categories.dialog.parent_none")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PARENT_NONE_VALUE}>
                    {t("categories.dialog.parent_none")}
                  </SelectItem>
                  {parentOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.parentId ? (
                <p
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {errors.parentId}
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="cat-description">
                {t("categories.dialog.description")}
              </Label>
              <Textarea
                id="cat-description"
                value={form.description}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, description: e.target.value }))
                }
                rows={3}
                disabled={submitting}
                aria-describedby="cat-description-help"
                maxLength={2000}
              />
              <p
                id="cat-description-help"
                className="text-xs text-muted-foreground"
              >
                {t("categories.dialog.description_help")}
              </p>
            </div>

            {serverError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onClose()}
              disabled={submitting}
            >
              {t("categories.dialog.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("categories.dialog.saving")}</span>
                </>
              ) : (
                <span>{t("categories.dialog.save")}</span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------
// Delete confirmation. We use AlertDialog (not Dialog) because the action is
// destructive — Radix gives us focus trap and the destructive role for free.
// ----------------------------------------------------------------------------

interface DeleteDialogProps {
  target: Category | null;
  categories: Category[];
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteDialog({
  target,
  categories,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteDialogProps) {
  const t = useTranslator();

  const childCount = React.useMemo(() => {
    if (!target) return 0;
    return categories.filter((c) => c.parentId === target.id).length;
  }, [target, categories]);

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("categories.delete.confirm_title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target ? (
              <>
                {t("categories.delete.confirm_body").replace(
                  "{name}",
                  target.name,
                )}
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {childCount > 0 ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {t("categories.delete.has_children").replace(
                "{count}",
                String(childCount),
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>
            {t("categories.delete.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon
                  className="animate-spin"
                />
                <span>{t("categories.delete.deleting")}</span>
              </>
            ) : (
              <span>{t("categories.delete.confirm")}</span>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
