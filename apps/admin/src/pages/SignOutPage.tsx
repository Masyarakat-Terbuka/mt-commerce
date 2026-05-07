/**
 * Sign-out route.
 *
 * Implemented as a route component (rather than a button-side effect) so
 * sign-out is a navigable URL (`/keluar`). That keeps the dropdown menu
 * item declarative — `<Link to="/keluar">` — and lets a deep link or
 * browser back/forward land in a sane state.
 *
 * On mount: call the SDK, clear the cache, redirect to /login. We render
 * a small spinner while the call is in flight; if the network fails we
 * still send the user to /login because the cookie is already invalid
 * server-side, and lingering on this page would feel broken.
 */
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useAuthActions } from "@/lib/auth";
import { useTranslator } from "@/lib/i18n";

export function SignOutPage() {
  const navigate = useNavigate();
  const { clearAll } = useAuthActions();
  const t = useTranslator();
  const ranRef = React.useRef(false);

  React.useEffect(() => {
    // StrictMode runs effects twice in dev. Guarding with a ref keeps the
    // sign-out call exactly once per mount in development without changing
    // production behavior.
    if (ranRef.current) return;
    ranRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        await api.admin.auth.signOut();
      } catch {
        // Server may already have invalidated the cookie. Either way, the
        // local cache is the next thing to clear.
      } finally {
        if (!cancelled) {
          clearAll();
          await navigate({ to: "/login" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearAll, navigate]);

  return (
    <div className="flex min-h-svh items-center justify-center">
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner />
        <span>{t("common.loading")}</span>
      </div>
    </div>
  );
}
