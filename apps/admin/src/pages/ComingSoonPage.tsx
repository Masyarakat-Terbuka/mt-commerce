/**
 * Catch-all placeholder for routes that exist in the navigation but whose
 * implementation belongs to a future wave. Calm copy — the user is in the
 * right place; the feature simply isn't ready yet.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useTranslator } from "@/lib/i18n";

export function ComingSoonPage() {
  const t = useTranslator();
  return (
    <div className="flex flex-1 items-center justify-center">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyTitle>{t("page.coming_soon.title")}</EmptyTitle>
          <EmptyDescription>{t("page.coming_soon.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
