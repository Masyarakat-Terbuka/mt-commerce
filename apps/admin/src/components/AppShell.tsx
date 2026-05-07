/**
 * The gated layout — sidebar, topbar, and an `<Outlet />` for the active
 * page.
 *
 * Why a single `AppShell` instead of one component per concern:
 *   - The sidebar's collapse state, the topbar's search trigger, and the
 *     mobile sheet behavior all live inside `<SidebarProvider>`. Keeping
 *     them together means consumers don't have to thread the provider
 *     through every page.
 *   - The shell is rendered once per gated navigation (the gate route's
 *     `component`). Pages mount inside `<Outlet />`, so navigating between
 *     `/produk` and `/` does not unmount the sidebar — focus and scroll
 *     state stay put.
 *
 * Mobile behavior comes for free from shadcn's Sidebar: it switches to a
 * sheet when `useIsMobile()` returns true. The trigger lives in the topbar.
 */
import * as React from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Home01Icon,
  PackageIcon,
  ShoppingBag01Icon,
  UserMultiple02Icon,
  Settings02Icon,
  Logout01Icon,
  UserCircleIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SearchCommand } from "@/components/SearchCommand";
import { useTranslator } from "@/lib/i18n";
import { useSession } from "@/lib/auth";
import { initialsFromName } from "@/lib/format";

interface NavItem {
  to: string;
  labelKey: string;
  icon: typeof Home01Icon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.home", icon: Home01Icon },
  { to: "/produk", labelKey: "nav.produk", icon: PackageIcon },
  { to: "/pesanan", labelKey: "nav.pesanan", icon: ShoppingBag01Icon },
  { to: "/pelanggan", labelKey: "nav.pelanggan", icon: UserMultiple02Icon },
  { to: "/pengaturan", labelKey: "nav.pengaturan", icon: Settings02Icon },
] as const;

function isActivePath(currentPath: string, target: string): boolean {
  if (target === "/") return currentPath === "/";
  return currentPath === target || currentPath.startsWith(`${target}/`);
}

export function AppShell() {
  const t = useTranslator();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useSession();
  const [searchOpen, setSearchOpen] = React.useState(false);

  const displayName = me?.displayName ?? "";
  const email = me?.user.email ?? "";
  const initials = displayName ? initialsFromName(displayName) : "?";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <img
              src="/logo.png"
              alt="mt-commerce"
              width={28}
              height={28}
              className="size-7 rounded-sm"
            />
            <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-normal">mt-commerce</span>
              <span className="text-[0.6875rem] text-muted-foreground">
                Admin
              </span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => {
                  const active = isActivePath(pathname, item.to);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={t(item.labelKey)}
                      >
                        <Link to={item.to}>
                          <HugeiconsIcon icon={item.icon} data-icon />
                          <span>{t(item.labelKey)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg" tooltip={displayName || email}>
                    <Avatar className="size-7 rounded-md">
                      <AvatarFallback className="rounded-md text-[0.6875rem]">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate text-sm font-medium">
                        {displayName || email || t("common.account")}
                      </span>
                      {email ? (
                        <span className="truncate text-[0.6875rem] text-sidebar-foreground/70">
                          {email}
                        </span>
                      ) : null}
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  className="min-w-56"
                >
                  <DropdownMenuLabel className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {displayName || t("common.account")}
                    </span>
                    {email ? (
                      <span className="text-xs text-muted-foreground">
                        {email}
                      </span>
                    ) : null}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>
                    <HugeiconsIcon icon={UserCircleIcon} data-icon />
                    {t("common.account")}
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/keluar">
                      <HugeiconsIcon icon={Logout01Icon} data-icon />
                      {t("common.sign_out")}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="flex items-center justify-between px-2 pt-1 pb-1 group-data-[collapsible=icon]:hidden">
            <span className="text-[0.6875rem] text-sidebar-foreground/60">
              {t("language.label")}
            </span>
            <LanguageSwitcher />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-4" />
          <Breadcrumbs />
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="inline-flex h-7 items-center gap-2 rounded-md border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
            >
              <HugeiconsIcon
                icon={Search01Icon}
                data-icon
                className="size-3.5"
              />
              <span>{t("topbar.search_placeholder")}</span>
              <kbd className="ml-1 rounded-sm border bg-muted px-1 font-mono text-[0.625rem]">
                {t("topbar.search_shortcut")}
              </kbd>
            </button>
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          <Outlet />
        </div>
      </SidebarInset>
      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </SidebarProvider>
  );
}
