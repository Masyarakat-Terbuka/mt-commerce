/**
 * HeaderAccountLink — replaces the static "Akun" link with the customer's
 * display name when a session is present.
 *
 * Progressive enhancement is the contract: the server-rendered Header
 * still emits a fallback `<a>` to `/account` so JavaScript-disabled
 * visitors and the initial paint both have a working link. This island
 * mounts with `client:idle` and quietly upgrades the label once `me()`
 * resolves.
 *
 * Design discipline: we keep the styling identical to the static link
 * (`t-body text-fg`, hover accent). The only change is the label text.
 * No badges, no count, no avatar — those would clash with the calm
 * Saturdays NYC × Muji header.
 */
import { useEffect, useState } from "react";
import { refreshAccount } from "../lib/account.js";

export interface HeaderAccountLinkProps {
  /** Where the link points (`/account` or `/en/account`). */
  href: string;
  /** Default label when anonymous (matches server-rendered fallback). */
  fallbackLabel: string;
  /**
   * Class names applied to the anchor. Passed in by the parent so the
   * island can match the desktop / mobile slot it lives in without
   * hard-coding two variants.
   */
  className?: string;
}

export default function HeaderAccountLink({
  href,
  fallbackLabel,
  className,
}: HeaderAccountLinkProps) {
  const [label, setLabel] = useState<string>(fallbackLabel);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await refreshAccount();
        if (cancelled) return;
        const name =
          me.customer?.displayName ??
          me.user?.name ??
          me.user?.email ??
          null;
        if (name) {
          // Truncate aggressively — long names blow out the header layout.
          // 18 chars matches the visual budget at desktop sizes.
          setLabel(name.length > 18 ? `${name.slice(0, 17)}…` : name);
        }
      } catch {
        // Anonymous fallback already in place; quiet on transport failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <a href={href} className={className}>
      {label}
    </a>
  );
}
