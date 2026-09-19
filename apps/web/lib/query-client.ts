import { QueryClient } from "@tanstack/react-query";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR we want a non-zero staleTime so the client does not refetch
        // immediately after hydrating the server-rendered session.
        staleTime: 5000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: a fresh client per request keeps one user's cache out of another's.
    return makeQueryClient();
  }

  // Browser: a singleton preserves the cache across navigation and gives
  // HydrationBoundary a stable target if React suspends during first render.
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
