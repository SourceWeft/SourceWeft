/**
 * Which marketing routes have been migrated into `app/[locale]/` and therefore
 * participate in locale-prefixed routing. Shared by the proxy (which prefixes /
 * rewrites / redirects only these) and the marketing chrome (which only adds a
 * locale prefix to links whose target is localized). App-tree routes
 * (`/dashboard`, `/auth`, …) are never in this list — their locale rides the
 * cookie, not the URL (D3).
 *
 * This list grows one entry per migrated section as Phase 1A proceeds. A route
 * absent here still renders (from its current root location) — it just is not
 * locale-prefixed yet, so nothing 404s mid-migration.
 */

/** Exact paths that are localized (the landing lives at the bare root). */
const LOCALIZED_EXACT = new Set<string>(["/"]);

/** Path prefixes whose subtree is localized (e.g. "/about", "/blog"). Grows over Phase 1A. */
const LOCALIZED_PREFIXES: readonly string[] = [
  "/about",
  "/changelog",
  "/blog",
  "/mcp",
  "/skills",
  "/download",
];

/** True when `bare` (a locale-stripped pathname) belongs to the localized marketing tree. */
export function isLocalizedPath(bare: string): boolean {
  if (LOCALIZED_EXACT.has(bare)) {
    return true;
  }
  return LOCALIZED_PREFIXES.some(
    (prefix) => bare === prefix || bare.startsWith(`${prefix}/`),
  );
}
