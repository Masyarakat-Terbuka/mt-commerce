/**
 * `renderWithProviders` — RTL render wrapper that bolts the admin app's
 * runtime providers onto a component under test:
 *
 *   - `QueryClientProvider` (TanStack Query) with retries disabled and a
 *     fresh client per render so caches don't leak across tests.
 *   - `LocaleProvider` (the i18n context) so `useTranslator` /
 *     `useLocale` resolve. Defaults to "en" — strings render as the
 *     en.json values which keep test assertions readable.
 *
 * Pages that pull `useNavigate` / `useSearch` from `@tanstack/react-router`
 * mock those hooks at the top of their test file. The router is
 * deliberately NOT included here: most state-transition tests don't need
 * it, and bolting in a memory-history router for every test would
 * dominate the test setup.
 */
import * as React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocaleProvider } from "@/lib/i18n-provider";

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderWithProvidersOptions = {},
) {
  const { queryClient, ...rtlOptions } = options;
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 0,
        },
        mutations: {
          retry: false,
        },
      },
    });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <LocaleProvider>{children}</LocaleProvider>
      </QueryClientProvider>
    );
  }

  return {
    queryClient: client,
    ...render(ui, { wrapper: Wrapper, ...rtlOptions }),
  };
}
