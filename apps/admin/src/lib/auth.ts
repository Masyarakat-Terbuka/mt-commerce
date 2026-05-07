/**
 * Auth state for the admin app.
 *
 * We keep the source of truth in TanStack Query so every consumer (sidebar
 * footer, route gate, sign-out handler) reads the same cached `AuthMe`. The
 * gate component below redirects to `/login` on a 401 from `/admin/v1/auth/me`
 * and shows a Skeleton shell while the check is in flight.
 *
 * The query is `retry: false` because a 401 is the success path of "user is
 * not signed in" — retrying it just delays the redirect by 3× the network
 * round-trip.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type AuthMe } from "@/lib/api";

export const SESSION_QUERY_KEY = ["admin", "auth", "me"] as const;

interface SessionState {
  data: AuthMe | null;
  isLoading: boolean;
  isError: boolean;
}

export function useSession(): SessionState {
  const query = useQuery<AuthMe | null>({
    queryKey: SESSION_QUERY_KEY,
    // The /me call returns the user + staff role. A 401 means "no session" —
    // we surface that as `data === null` so the gate component can treat it
    // as a routing decision instead of an error.
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
    // Five-minute stale time keeps the session check from hammering the API
    // on every navigation. The gate runs once per app load; subsequent route
    // changes use the cached value.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    isError: query.isError,
  };
}

/**
 * Imperative helpers used by the login / sign-out flows. They mutate the
 * query cache directly so the rest of the app re-renders with the fresh
 * session state without an extra round-trip.
 */
export function useAuthActions() {
  const queryClient = useQueryClient();
  return {
    setSession(me: AuthMe | null) {
      queryClient.setQueryData(SESSION_QUERY_KEY, me);
    },
    invalidate() {
      return queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
    clearAll() {
      queryClient.clear();
    },
  };
}
