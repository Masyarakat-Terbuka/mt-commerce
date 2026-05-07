/**
 * Beranda — admin dashboard.
 *
 * Four KPI cards across the top, an "Aktivitas terbaru" empty section
 * below. The numbers are placeholders today: orders/customers/checkouts
 * modules will land in subsequent waves and wire into matching SDK calls
 * (see TODOs).
 *
 * The grid is responsive: 1 column on mobile, 2 on tablet, 4 on desktop.
 * Cards use the calm shadcn defaults — no custom shadow or color overrides
 * — so they pick up the radix-mira preset cleanly.
 */
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ShoppingCart01Icon,
  MoneyBag01Icon,
  UserAdd01Icon,
  TaskAdd01Icon,
} from "@hugeicons/core-free-icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useTranslator } from "@/lib/i18n";

interface KpiCardProps {
  titleKey: string;
  icon: typeof ShoppingCart01Icon;
}

function KpiCard({ titleKey, icon }: KpiCardProps) {
  const t = useTranslator();
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <HugeiconsIcon icon={icon} data-icon className="size-3.5" />
          <span>{t(titleKey)}</span>
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {t("dashboard.placeholder_value")}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

export function DashboardPage() {
  const t = useTranslator();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("dashboard.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("dashboard.subtitle")}
        </p>
      </div>

      {/* TODO: wire to sdk.admin.orders.summary() once the orders module ships. */}
      {/* TODO: wire pending checkouts to sdk.admin.checkouts.list({ state: 'awaiting_payment' }). */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard titleKey="dashboard.today_orders" icon={ShoppingCart01Icon} />
        <KpiCard titleKey="dashboard.revenue" icon={MoneyBag01Icon} />
        <KpiCard titleKey="dashboard.new_customers" icon={UserAdd01Icon} />
        <KpiCard
          titleKey="dashboard.pending_checkouts"
          icon={TaskAdd01Icon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("dashboard.activity_title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("dashboard.activity_empty")}</EmptyTitle>
              <EmptyDescription>{t("common.coming_soon")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}
