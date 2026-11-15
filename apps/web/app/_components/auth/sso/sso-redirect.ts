const REDIRECT_PARAM = "redirectTo"

/**
 * The current `redirectTo` query parameter, or `null` before hydration or when
 * it is absent. Read from `window.location.search` (not `useSearchParams`) so
 * it stays safe inside the statically generated `/auth/*` pages, matching the
 * rest of the auth UI — the provider's own `redirectTo` getter reads it the
 * same way, so this is only the string passthrough, not a second resolver of
 * the post-sign-in destination.
 */
export function currentRedirectTo(isHydrated: boolean): string | null {
  if (!isHydrated || typeof window === "undefined") return null
  const value = new URLSearchParams(window.location.search).get(REDIRECT_PARAM)
  return value?.trim() || null
}

/**
 * Append the current `redirectTo` to `path` so the post-sign-in destination
 * survives navigation between the sign-in page and `/auth/sso` (and back).
 */
export function withRedirectTo(path: string, isHydrated: boolean): string {
  const redirectTo = currentRedirectTo(isHydrated)
  return redirectTo
    ? `${path}?${REDIRECT_PARAM}=${encodeURIComponent(redirectTo)}`
    : path
}
