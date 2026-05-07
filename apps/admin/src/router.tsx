/**
 * TanStack Router setup — code-based, not file-based.
 *
 * The admin shell's route count is small enough (login + 5 gated screens)
 * that the file-route generator's extra build step is more friction than
 * it's worth. Code-based routes also keep the route tree visible in one
 * file, which makes auth-gating and breadcrumb wiring easier to reason
 * about.
 *
 * Auth gating lives in `gatedRoute.beforeLoad`: every admin route waits on
 * the cached `/admin/v1/auth/me` query before rendering. The gate redirects
 * to `/login` when the session is missing OR when the auth account exists
 * but has no staff role. Routes mark `staleTime` so the second navigation
 * does not refetch.
 */
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, type AuthMe } from "@/lib/api";
import { SESSION_QUERY_KEY } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { ProductEditorPage } from "@/pages/ProductEditorPage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { SignOutPage } from "@/pages/SignOutPage";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

/**
 * Public routes: login. We still need the root context, but no shell.
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/**
 * Sign-out route. Calls the SDK, clears the cache, redirects to /login.
 * Implemented as a route (not a button-only handler) so `Link to="/keluar"`
 * works from anywhere — the dropdown in the sidebar footer takes advantage.
 */
const signOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/keluar",
  component: SignOutPage,
});

/**
 * The gated layout route. Every admin screen mounts under it, so the
 * `beforeLoad` check runs exactly once per navigation tree, not per leaf.
 *
 * `beforeLoad` is the right place for auth gates in TanStack Router — it
 * runs before the loader and before the component, so a redirect doesn't
 * waste a render. We resolve the session through the query cache so the
 * sidebar's `useSession` hit is shared with the gate decision.
 */
const gatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "gated",
  beforeLoad: async ({ context, location }) => {
    const cached = context.queryClient.getQueryData<AuthMe | null>(
      SESSION_QUERY_KEY,
    );
    let me: AuthMe | null = cached ?? null;
    if (cached === undefined) {
      // First navigation: hydrate the cache. We don't `await` if we already
      // have it — re-renders should be free.
      try {
        me = await context.queryClient.fetchQuery<AuthMe | null>({
          queryKey: SESSION_QUERY_KEY,
          queryFn: async () => {
            try {
              return await api.admin.auth.me();
            } catch (err) {
              if (err instanceof ApiError && err.status === 401) {
                return null;
              }
              throw err;
            }
          },
          staleTime: 5 * 60 * 1000,
        });
      } catch {
        me = null;
      }
    }
    if (me === null || me.role === null) {
      throw redirect({
        to: "/login",
        search: location.pathname === "/" ? undefined : { from: location.pathname },
      });
    }
  },
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/",
  component: DashboardPage,
});

const productsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/produk",
  component: ProductsPage,
});

const productNewRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/produk/baru",
  component: () => <ProductEditorPage mode="create" />,
});

const productEditRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/produk/$id",
  component: () => <ProductEditorPage mode="edit" />,
});

const ordersRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/pesanan",
  component: ComingSoonPage,
});

const customersRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/pelanggan",
  component: ComingSoonPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: "/pengaturan",
  component: ComingSoonPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signOutRoute,
  gatedRoute.addChildren([
    dashboardRoute,
    productsRoute,
    productNewRoute,
    productEditRoute,
    ordersRoute,
    customersRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Scroll restore so navigating between products and dashboard doesn't
    // strand the user halfway down a long table.
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
