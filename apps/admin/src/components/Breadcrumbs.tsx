/**
 * Path-driven breadcrumbs.
 *
 * TanStack Router's match list could power richer breadcrumbs (per-route
 * `staticData.breadcrumb`), but the admin shell's tree is shallow enough
 * that a path-segment lookup is cleaner: each segment maps to a
 * translation key, and unknown segments fall through to the segment
 * itself. As we add real detail routes (e.g. `/produk/:id`), they'll
 * graduate to a route-meta scheme.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useTranslator } from "@/lib/i18n";
import * as React from "react";

const SEGMENT_LABELS: Record<string, string> = {
  produk: "nav.produk",
  baru: "products.new_button",
  pesanan: "nav.pesanan",
  pelanggan: "nav.pelanggan",
  pengaturan: "nav.pengaturan",
};

export function Breadcrumbs() {
  const t = useTranslator();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{t("nav.home")}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  // Build cumulative paths so each crumb links to its own level.
  const crumbs = segments.map((segment, index) => {
    const path = "/" + segments.slice(0, index + 1).join("/");
    const labelKey = SEGMENT_LABELS[segment];
    const label = labelKey ? t(labelKey) : segment;
    return { path, label, segment };
  });

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/">{t("nav.home")}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <React.Fragment key={crumb.path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.path}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
