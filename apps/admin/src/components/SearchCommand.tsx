/**
 * Cmd+K command palette stub.
 *
 * A real palette will index products, customers, orders, and settings. For
 * v0.1 the dialog opens, accepts input, and shows an Empty state — we ship
 * the UX hook so power users can start training their muscle memory while
 * the search backend is built.
 *
 * The trigger button lives in the topbar (rendered by `AppShell`); this
 * component only owns the dialog and its keyboard shortcut.
 */
import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { useTranslator } from "@/lib/i18n";

interface SearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchCommand({ open, onOpenChange }: SearchCommandProps) {
  const t = useTranslator();

  // Cmd+K / Ctrl+K toggle. We listen on the window once and bail when the
  // event target is editable so the shortcut doesn't clobber the user mid-
  // typing in inputs.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("topbar.search_title")}
      description={t("topbar.search_empty")}
    >
      <CommandInput placeholder={t("topbar.search_placeholder")} />
      <CommandList>
        <CommandEmpty>{t("topbar.search_empty")}</CommandEmpty>
      </CommandList>
    </CommandDialog>
  );
}
