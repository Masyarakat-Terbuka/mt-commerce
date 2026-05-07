/**
 * AccountSidebarSignOut — tiny island for the sidebar's sign-out action.
 *
 * Sits in its own island (rather than embedding in a larger account
 * island) so the rest of the sidebar can stay server-rendered. The
 * button is text-styled to read as a link; the design system has no
 * dedicated "tertiary action" component and adding one for a single
 * use would be premature abstraction.
 */
import { useState } from "react";
import { signOutAndClear } from "../lib/account.js";

export interface AccountSidebarSignOutProps {
  /** Where to navigate after sign-out succeeds (typically the home page). */
  homeHref: string;
  labels: {
    signOut: string;
    signingOut: string;
  };
}

export default function AccountSidebarSignOut({
  homeHref,
  labels,
}: AccountSidebarSignOutProps) {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await signOutAndClear();
    } finally {
      // Even on transport failure, navigate away — the cached customerId
      // is already cleared, so reloading the account page would just bounce
      // the user back to /sign-in anyway.
      window.location.assign(homeHref);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={busy}
      aria-busy={busy}
      className="t-body text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline disabled:opacity-50"
    >
      {busy ? labels.signingOut : labels.signOut}
    </button>
  );
}
