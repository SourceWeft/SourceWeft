import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/**
 * Locale-aware navigation helpers for the marketing tree. `Link`, `redirect`,
 * `usePathname`, `useRouter` here automatically add/strip the locale prefix per
 * the `as-needed` routing config. Marketing components use these instead of
 * `next/link`; app-tree components keep using `next/link` (their URLs never
 * carry a locale, D3). Wired up in Phase 1A.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
