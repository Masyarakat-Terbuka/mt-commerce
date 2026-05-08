/**
 * Staf — staff and roles, active sessions, and API keys.
 *
 * Three tabs, all owner-aware:
 *   1. "Staf"        — staff_profile roster, with role + last sign-in. Owner-only.
 *                      Hidden for non-owners; the route still renders so an
 *                      admin who lands here gets a useful page (sessions and
 *                      API keys), not an empty shell.
 *   2. "Sesi aktif"  — the caller's own active sessions. Per-row revoke with
 *                      AlertDialog confirm because logging yourself out of
 *                      another device is destructive in spirit even though
 *                      it is recoverable.
 *   3. "API key"     — owner/admin only API key management. The plaintext
 *                      secret is shown ONCE in a focused Card after creation;
 *                      we move focus to the copy button so the operator
 *                      cannot dismiss the dialog without acknowledging the
 *                      secret was visible.
 *
 * Why a single page with tabs (not three routes):
 *   The three surfaces are operationally adjacent: an operator typically
 *   reviews who has access, what sessions are open, and what keys are
 *   issued in the same sitting. A tabbed page keeps the cognitive context
 *   (route, breadcrumb, page title) stable across the three lists, and
 *   keeps each list's mutations local — there is no cross-tab cache
 *   invalidation that would justify shared route state.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  Loading03Icon,
  Tick02Icon,
  AlertCircleIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  api,
  ApiError,
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  type ApiKeyWithSecret,
  type AuthSession,
  type Role,
  type StaffListRow,
} from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useTranslator } from "@/lib/i18n";
import { useLocale } from "@/lib/i18n";
import { absoluteDate, relativeTime } from "@/lib/format";

// Query keys, kept module-local so the file is the single owner of the
// caches it invalidates. Mirrors the convention used by CategoriesPage.
const STAFF_QUERY_KEY = ["admin", "auth", "staff"] as const;
const SESSIONS_QUERY_KEY = ["admin", "auth", "sessions"] as const;
const API_KEYS_QUERY_KEY = ["admin", "auth", "apiKeys"] as const;

const ROLE_OPTIONS: readonly Role[] = ["owner", "admin", "staff", "viewer"] as const;

type TabValue = "staff" | "sessions" | "apiKeys";

export function StaffPage() {
  const t = useTranslator();
  const { data: me } = useSession();
  const role = me?.role ?? null;
  const isOwner = role === "owner";
  // Owner + admin can manage API keys; viewer/staff have no business there.
  const canManageApiKeys = role === "owner" || role === "admin";

  // Default to the first tab the caller can actually see. An admin landing
  // on /staf without owner rights opens on "Sesi aktif" rather than a tab
  // they cannot read.
  const initialTab: TabValue = isOwner
    ? "staff"
    : canManageApiKeys
      ? "sessions"
      : "sessions";
  const [tab, setTab] = React.useState<TabValue>(initialTab);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("staff.page.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("staff.page.subtitle")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          {isOwner ? (
            <TabsTrigger value="staff">{t("staff.tabs.staff")}</TabsTrigger>
          ) : null}
          <TabsTrigger value="sessions">
            {t("sessions.tabs.sessions")}
          </TabsTrigger>
          {canManageApiKeys ? (
            <TabsTrigger value="apiKeys">
              {t("api_keys.tabs.api_keys")}
            </TabsTrigger>
          ) : null}
        </TabsList>

        {isOwner ? (
          <TabsContent value="staff" className="mt-4">
            <StaffTab />
          </TabsContent>
        ) : null}
        <TabsContent value="sessions" className="mt-4">
          <SessionsTab />
        </TabsContent>
        {canManageApiKeys ? (
          <TabsContent value="apiKeys" className="mt-4">
            <ApiKeysTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Staff tab — owner-only roster + upsert dialog.
// ----------------------------------------------------------------------------

function StaffTab() {
  const t = useTranslator();
  const { locale } = useLocale();
  const [editor, setEditor] = React.useState<{
    open: boolean;
    target: StaffListRow | null;
  }>({ open: false, target: null });

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: STAFF_QUERY_KEY,
    queryFn: () => api.admin.auth.staff.list(),
  });
  const rows = data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{t("staff.list.title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("staff.list.subhead")}
          </p>
        </div>
        <Button onClick={() => setEditor({ open: true, target: null })}>
          <HugeiconsIcon icon={Add01Icon} data-icon />
          <span>{t("staff.action.add")}</span>
        </Button>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("staff.error.load_title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("staff.error.load_body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("staff.columns.name")}</TableHead>
                <TableHead>{t("staff.columns.email")}</TableHead>
                <TableHead className="w-32">
                  {t("staff.columns.role")}
                </TableHead>
                <TableHead className="w-44">
                  {t("staff.columns.added")}
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">
                    {t("staff.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 3 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length > 0 ? (
                rows.map((row) => (
                  <TableRow key={row.authUserId}>
                    <TableCell className="font-medium">
                      {row.displayName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.email ?? (
                        <span className="italic">
                          {t("staff.email.missing")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={row.role} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {absoluteDate(row.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({ open: true, target: row })
                        }
                        aria-label={`${t("staff.action.edit")} — ${row.displayName}`}
                      >
                        {t("staff.action.edit")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("staff.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("staff.empty.body")}
                        </EmptyDescription>
                      </EmptyHeader>
                      <Button
                        variant="outline"
                        className="mt-3"
                        onClick={() =>
                          setEditor({ open: true, target: null })
                        }
                      >
                        <HugeiconsIcon icon={Add01Icon} data-icon />
                        <span>{t("staff.action.add")}</span>
                      </Button>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <StaffEditorDialog
        open={editor.open}
        target={editor.target}
        onClose={() => setEditor({ open: false, target: null })}
      />
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const t = useTranslator();
  const variant: React.ComponentProps<typeof Badge>["variant"] =
    role === "owner"
      ? "default"
      : role === "admin"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{t(`staff.role.${role}`)}</Badge>;
}

interface StaffEditorDialogProps {
  open: boolean;
  target: StaffListRow | null;
  onClose: () => void;
}

interface StaffFormState {
  email: string;
  role: Role;
  displayName: string;
}

function emptyStaffForm(): StaffFormState {
  return { email: "", role: "staff", displayName: "" };
}

function staffFormFromRow(row: StaffListRow): StaffFormState {
  return {
    email: row.email ?? "",
    role: row.role,
    displayName: row.displayName,
  };
}

function StaffEditorDialog({
  open,
  target,
  onClose,
}: StaffEditorDialogProps) {
  const t = useTranslator();
  const queryClient = useQueryClient();
  const isEditMode = target !== null;

  const [form, setForm] = React.useState<StaffFormState>(() =>
    target ? staffFormFromRow(target) : emptyStaffForm(),
  );
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Reset on open/target change without an effect — same pattern as
  // CategoriesPage. The trigger key isolates the "did the dialog just open
  // for a different target?" question into a single render-time compare.
  const triggerKey = open ? `open:${target?.authUserId ?? "__new__"}` : "closed";
  const [lastKey, setLastKey] = React.useState(triggerKey);
  if (lastKey !== triggerKey) {
    setLastKey(triggerKey);
    if (open) {
      setForm(target ? staffFormFromRow(target) : emptyStaffForm());
      setServerError(null);
    }
  }

  const submit = useMutation({
    mutationFn: async () => {
      // The current API endpoint takes `authUserId`, not email. In edit
      // mode we forward the existing id; in create mode there is no id
      // yet to assign — surface a clear message instead of guessing.
      if (!isEditMode || !target) {
        throw new Error("create_unsupported");
      }
      return api.admin.auth.staff.upsert({
        authUserId: target.authUserId,
        role: form.role,
        displayName: form.displayName.trim() || target.displayName,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: STAFF_QUERY_KEY });
      toast.success(
        t(
          isEditMode
            ? "staff.dialog.success.updated"
            : "staff.dialog.success.created",
        ),
      );
      onClose();
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "create_unsupported") {
        setServerError(t("staff.dialog.error.create_unsupported"));
        return;
      }
      if (err instanceof ApiError) {
        setServerError(err.message || t("staff.dialog.error.server"));
        return;
      }
      setServerError(t("staff.dialog.error.server"));
    },
  });

  const submitting = submit.isPending;

  function handleOpenChange(next: boolean) {
    if (submitting && !next) return;
    if (!next) onClose();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    submit.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {t(
                isEditMode
                  ? "staff.dialog.edit_title"
                  : "staff.dialog.create_title",
              )}
            </DialogTitle>
            <DialogDescription>
              {t("staff.dialog.invite_note")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="staff-email">
                {t("staff.dialog.email")}
              </Label>
              <Input
                id="staff-email"
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, email: e.target.value }))
                }
                disabled={submitting || isEditMode}
                required
                autoFocus={!isEditMode}
                aria-describedby="staff-email-help"
                maxLength={254}
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <p
                id="staff-email-help"
                className="text-xs text-muted-foreground"
              >
                {isEditMode
                  ? t("staff.dialog.email_help_edit")
                  : t("staff.dialog.email_help_create")}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-displayName">
                {t("staff.dialog.display_name")}
              </Label>
              <Input
                id="staff-displayName"
                value={form.displayName}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    displayName: e.target.value,
                  }))
                }
                disabled={submitting}
                required={!isEditMode}
                autoFocus={isEditMode}
                maxLength={200}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-role">{t("staff.dialog.role")}</Label>
              <Select
                value={form.role}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, role: value as Role }))
                }
                disabled={submitting}
              >
                <SelectTrigger id="staff-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`staff.role.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("staff.dialog.role_help")}
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
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("common.saving")}</span>
                </>
              ) : (
                <span>{t("common.save")}</span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------
// Sessions tab — caller's own active sessions + per-row revoke.
// ----------------------------------------------------------------------------

function SessionsTab() {
  const t = useTranslator();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = React.useState<AuthSession | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => api.admin.auth.sessions.list(),
  });
  const sessions = data ?? [];

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.admin.auth.sessions.revoke(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      toast.success(t("sessions.revoke.success"));
      setConfirm(null);
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError && err.message
          ? err.message
          : t("sessions.revoke.error"),
      );
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">{t("sessions.list.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("sessions.list.subhead")}
        </p>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("sessions.error.load_title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("sessions.error.load_body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("sessions.columns.device")}</TableHead>
                <TableHead className="w-44">
                  {t("sessions.columns.ip")}
                </TableHead>
                <TableHead className="w-44">
                  {t("sessions.columns.created")}
                </TableHead>
                <TableHead className="w-44">
                  {t("sessions.columns.expires")}
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">
                    {t("sessions.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 2 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-56" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : sessions.length > 0 ? (
                sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      {session.userAgent ?? (
                        <span className="italic text-muted-foreground">
                          {t("sessions.user_agent.unknown")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {session.ipAddress ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeTime(session.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeTime(session.expiresAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirm(session)}
                        aria-label={`${t("sessions.action.revoke")} — ${
                          session.userAgent ?? session.id
                        }`}
                      >
                        <HugeiconsIcon icon={Delete02Icon} data-icon />
                        <span className="sr-only sm:not-sr-only">
                          {t("sessions.action.revoke")}
                        </span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("sessions.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("sessions.empty.body")}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next && !revoke.isPending) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sessions.revoke.confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.revoke.confirm_body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                if (confirm) revoke.mutate(confirm.id);
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("common.processing")}</span>
                </>
              ) : (
                <span>{t("sessions.revoke.confirm")}</span>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ----------------------------------------------------------------------------
// API keys tab — list, create-with-secret-once, revoke.
// ----------------------------------------------------------------------------

function ApiKeysTab() {
  const t = useTranslator();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const [creating, setCreating] = React.useState(false);
  // After a successful create the page renders a Card with the secret,
  // visible only until the operator dismisses it. The Card lives inside
  // the main view (not the dialog) so the dialog can close cleanly while
  // the secret stays in focus.
  const [createdKey, setCreatedKey] = React.useState<ApiKeyWithSecret | null>(
    null,
  );
  const [revokeTarget, setRevokeTarget] = React.useState<ApiKey | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: () => api.admin.auth.apiKeys.list(),
  });
  const keys = data ?? [];

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.admin.auth.apiKeys.revoke(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      toast.success(t("api_keys.revoke.success"));
      setRevokeTarget(null);
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError && err.message
          ? err.message
          : t("api_keys.revoke.error"),
      );
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{t("api_keys.list.title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("api_keys.list.subhead")}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <HugeiconsIcon icon={Add01Icon} data-icon />
          <span>{t("api_keys.action.create")}</span>
        </Button>
      </div>

      {createdKey ? (
        <NewApiKeyCallout
          created={createdKey}
          onDismiss={() => setCreatedKey(null)}
        />
      ) : null}

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("api_keys.error.load_title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("api_keys.error.load_body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("api_keys.columns.label")}</TableHead>
                <TableHead>{t("api_keys.columns.scopes")}</TableHead>
                <TableHead className="w-44">
                  {t("api_keys.columns.last_used")}
                </TableHead>
                <TableHead className="w-44">
                  {t("api_keys.columns.created")}
                </TableHead>
                <TableHead className="w-32">
                  {t("api_keys.columns.status")}
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">
                    {t("api_keys.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 2 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : keys.length > 0 ? (
                keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col gap-0.5">
                        <span>{key.name}</span>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {key.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge
                            key={scope}
                            variant="outline"
                            className="font-mono text-[0.6875rem]"
                          >
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {key.lastUsedAt ? (
                        relativeTime(key.lastUsedAt, locale)
                      ) : (
                        <span className="italic">
                          {t("api_keys.last_used.never")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {absoluteDate(key.createdAt, locale)}
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? (
                        <Badge variant="secondary">
                          {t("api_keys.status.revoked")}
                        </Badge>
                      ) : (
                        <Badge>{t("api_keys.status.active")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {key.revokedAt ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeTarget(key)}
                          aria-label={`${t("api_keys.action.revoke")} — ${key.name}`}
                        >
                          <HugeiconsIcon icon={Delete02Icon} data-icon />
                          <span className="sr-only sm:not-sr-only">
                            {t("api_keys.action.revoke")}
                          </span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("api_keys.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("api_keys.empty.body")}
                        </EmptyDescription>
                      </EmptyHeader>
                      <Button
                        variant="outline"
                        className="mt-3"
                        onClick={() => setCreating(true)}
                      >
                        <HugeiconsIcon icon={Add01Icon} data-icon />
                        <span>{t("api_keys.action.create")}</span>
                      </Button>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateApiKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreatedKey(created);
          setCreating(false);
        }}
      />

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next && !revoke.isPending) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("api_keys.revoke.confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget
                ? t("api_keys.revoke.confirm_body").replace(
                    "{label}",
                    revokeTarget.name,
                  )
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                if (revokeTarget) revoke.mutate(revokeTarget.id);
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("common.processing")}</span>
                </>
              ) : (
                <span>{t("api_keys.revoke.confirm")}</span>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface NewApiKeyCalloutProps {
  created: ApiKeyWithSecret;
  onDismiss: () => void;
}

/**
 * The freshly-issued secret is shown ONCE in a high-contrast Card. We move
 * focus to the copy button when the callout mounts so screen-reader users
 * land directly on the actionable element, and we set `tabIndex={-1}` on
 * the container to make it keyboard-reachable as a region.
 */
function NewApiKeyCallout({ created, onDismiss }: NewApiKeyCalloutProps) {
  const t = useTranslator();
  const copyButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    copyButtonRef.current?.focus();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("api_keys.created.copy_error"));
    }
  }

  return (
    <Card
      role="region"
      aria-labelledby="new-api-key-title"
      tabIndex={-1}
      className="border-primary/40 bg-primary/5"
    >
      <CardHeader>
        <CardTitle
          id="new-api-key-title"
          className="flex items-center gap-2 text-sm"
        >
          <HugeiconsIcon icon={AlertCircleIcon} data-icon />
          <span>{t("api_keys.created.title")}</span>
        </CardTitle>
        <CardDescription>{t("api_keys.created.warning")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-api-key-secret">
            {t("api_keys.created.secret_label")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="new-api-key-secret"
              readOnly
              value={created.secret}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button
              ref={copyButtonRef}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copy();
              }}
              aria-label={t("api_keys.created.copy")}
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                data-icon
              />
              <span>
                {copied
                  ? t("api_keys.created.copied")
                  : t("api_keys.created.copy")}
              </span>
            </Button>
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t("api_keys.created.dismiss")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface CreateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: ApiKeyWithSecret) => void;
}

interface CreateApiKeyFormState {
  label: string;
  scopes: ApiKeyScope[];
  expiresAt: string;
}

function emptyApiKeyForm(): CreateApiKeyFormState {
  return { label: "", scopes: [], expiresAt: "" };
}

function CreateApiKeyDialog({
  open,
  onClose,
  onCreated,
}: CreateApiKeyDialogProps) {
  const t = useTranslator();
  const [form, setForm] = React.useState<CreateApiKeyFormState>(emptyApiKeyForm);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [labelError, setLabelError] = React.useState<string | null>(null);
  const [scopeError, setScopeError] = React.useState<string | null>(null);

  // Same trigger-key reset pattern as the other dialogs.
  const triggerKey = open ? "open" : "closed";
  const [lastKey, setLastKey] = React.useState(triggerKey);
  if (lastKey !== triggerKey) {
    setLastKey(triggerKey);
    if (open) {
      setForm(emptyApiKeyForm());
      setServerError(null);
      setLabelError(null);
      setScopeError(null);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const label = form.label.trim();
      let valid = true;
      if (label.length === 0) {
        setLabelError(t("api_keys.dialog.error.label_required"));
        valid = false;
      } else {
        setLabelError(null);
      }
      if (form.scopes.length === 0) {
        setScopeError(t("api_keys.dialog.error.scope_required"));
        valid = false;
      } else {
        setScopeError(null);
      }
      if (!valid) throw new Error("validation");

      // expiresAt is reserved for a future API change; we collect it but
      // the SDK already drops it before sending the request, so the
      // round-trip stays faithful to the v0.1 contract.
      const expiresAt =
        form.expiresAt.length > 0 ? new Date(form.expiresAt) : undefined;

      return api.admin.auth.apiKeys.create({
        label,
        scopes: form.scopes,
        ...(expiresAt && !Number.isNaN(expiresAt.getTime())
          ? { expiresAt }
          : {}),
      });
    },
    onSuccess: (created) => {
      toast.success(t("api_keys.dialog.success"));
      onCreated(created);
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "validation") {
        setServerError(t("api_keys.dialog.error.validation"));
        return;
      }
      if (err instanceof ApiError) {
        setServerError(err.message || t("api_keys.dialog.error.server"));
        return;
      }
      setServerError(t("api_keys.dialog.error.server"));
    },
  });

  const submitting = create.isPending;

  function toggleScope(scope: ApiKeyScope) {
    setForm((prev) => {
      const next = prev.scopes.includes(scope)
        ? prev.scopes.filter((s) => s !== scope)
        : [...prev.scopes, scope];
      return { ...prev, scopes: next };
    });
    if (scopeError) setScopeError(null);
  }

  function handleOpenChange(next: boolean) {
    if (submitting && !next) return;
    if (!next) onClose();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("api_keys.dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("api_keys.dialog.subhead")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="apik-label">
                {t("api_keys.dialog.label")}
              </Label>
              <Input
                id="apik-label"
                value={form.label}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, label: e.target.value }));
                  if (labelError) setLabelError(null);
                }}
                aria-invalid={labelError !== null}
                aria-describedby={labelError ? "apik-label-error" : "apik-label-help"}
                disabled={submitting}
                required
                autoFocus
                maxLength={200}
              />
              {labelError ? (
                <p
                  id="apik-label-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {labelError}
                </p>
              ) : (
                <p id="apik-label-help" className="text-xs text-muted-foreground">
                  {t("api_keys.dialog.label_help")}
                </p>
              )}
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                {t("api_keys.dialog.scopes")}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t("api_keys.dialog.scopes_help")}
              </p>
              <div className="flex flex-col gap-2 rounded-md border p-3">
                {API_KEY_SCOPES.map((scope) => {
                  const id = `apik-scope-${scope}`;
                  const checked = form.scopes.includes(scope);
                  return (
                    <label
                      key={scope}
                      htmlFor={id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        id={id}
                        checked={checked}
                        onChange={() => toggleScope(scope)}
                        disabled={submitting}
                        className="mt-0.5"
                      />
                      <span className="flex flex-col">
                        <span className="font-mono text-xs">{scope}</span>
                        <span className="text-xs text-muted-foreground">
                          {t(`api_keys.scope.${scope}`)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {scopeError ? (
                <p role="alert" className="text-xs text-destructive">
                  {scopeError}
                </p>
              ) : null}
            </fieldset>

            <div className="grid gap-1.5">
              <Label htmlFor="apik-expires">
                {t("api_keys.dialog.expires")}
              </Label>
              <Input
                id="apik-expires"
                type="date"
                value={form.expiresAt}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, expiresAt: e.target.value }))
                }
                disabled={submitting}
                aria-describedby="apik-expires-help"
              />
              <p id="apik-expires-help" className="text-xs text-muted-foreground">
                {t("api_keys.dialog.expires_help")}
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
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("common.processing")}</span>
                </>
              ) : (
                <span>{t("api_keys.dialog.create")}</span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
