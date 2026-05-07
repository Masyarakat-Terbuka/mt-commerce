/**
 * App root: composes the providers (theme, locale, query) and hands off to
 * the TanStack router. Everything visible is rendered by the route tree.
 *
 * The QueryClient lives at module scope so React.StrictMode's double-mount
 * in development does not throw away cache state between mounts. The router
 * is built lazily in `Inner` to bind it to that same client.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { LocaleProvider } from "@/lib/i18n-provider";
import { createAppRouter } from "@/router";

// Single client shared across the app. Defaults are conservative — admin
// data is sensitive, so we want freshness on focus, not aggressive caching.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetch on window focus is the right default for an admin app: a
      // staff member coming back to a tab after lunch should see current
      // data, not a 30-minute-old snapshot.
      refetchOnWindowFocus: true,
      // 1× retry — the SDK already maps network errors to typed `ApiError`,
      // and 401s short-circuit the gate. Default 3× retries delay redirects.
      retry: 1,
    },
  },
});

const router = createAppRouter(queryClient);

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <LocaleProvider>
          <RouterProvider router={router} />
        </LocaleProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
