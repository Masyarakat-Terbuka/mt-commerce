/**
 * Login screen.
 *
 * Better Auth's `/api/auth/sign-in/email` returns 401 for invalid credentials
 * and 200 with a session cookie on success. The SDK wraps that, then calls
 * `/admin/v1/auth/me` to fetch the staff role — we render the inline error
 * for any of these failure modes:
 *   - 401  → `login.error.invalid_credentials`
 *   - 200 + no role → `login.error.no_role`
 *   - anything else → `login.error.unknown`
 *
 * The form uses uncontrolled inputs read at submit time. A controlled form
 * would not improve UX here (no live validation, no field-level errors)
 * and uncontrolled keeps the React tree quieter on every keystroke.
 */
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, ApiError } from "@/lib/api";
import { useAuthActions } from "@/lib/auth";
import { useTranslator } from "@/lib/i18n";

type LoginErrorKey =
  | "login.error.invalid_credentials"
  | "login.error.no_role"
  | "login.error.unknown";

export function LoginPage() {
  const t = useTranslator();
  const navigate = useNavigate();
  const { setSession } = useAuthActions();
  const [submitting, setSubmitting] = React.useState(false);
  const [errorKey, setErrorKey] = React.useState<LoginErrorKey | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    setSubmitting(true);
    setErrorKey(null);
    try {
      const me = await api.admin.auth.signIn({ email, password });
      if (me.role === null) {
        // Authenticated but no staff profile — refuse entry and surface a
        // dedicated message rather than the generic "wrong credentials".
        setErrorKey("login.error.no_role");
        return;
      }
      setSession(me);
      await navigate({ to: "/" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setErrorKey("login.error.invalid_credentials");
      } else {
        setErrorKey("login.error.unknown");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("login.title")}</CardTitle>
          <CardDescription>{t("login.description")}</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-email">
                  {t("login.email")}
                </FieldLabel>
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={submitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="login-password">
                  {t("login.password")}
                </FieldLabel>
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  disabled={submitting}
                />
              </Field>
            </FieldGroup>
            {errorKey ? (
              <Alert variant="destructive">
                <AlertDescription>{t(errorKey)}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("login.signing_in")}</span>
                </>
              ) : (
                <span>{t("login.submit")}</span>
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
