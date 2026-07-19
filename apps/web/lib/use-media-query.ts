"use client";

import { useEffect, useState } from "react";

/**
 * Layout breakpoints, aligned with the Tailwind `md` / `lg` screens. Kept as
 * named constants so a breakpoint change is a single edit rather than a
 * search-and-replace across every component that reads one.
 */
export const BREAKPOINTS = {
  md: "(min-width: 768px)",
  lg: "(min-width: 1024px)",
} as const;

/**
 * Tracks a media query. Starts as `false` on the server and on the first client
 * render, then syncs in an effect — this keeps SSR output stable and avoids a
 * hydration mismatch.
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
