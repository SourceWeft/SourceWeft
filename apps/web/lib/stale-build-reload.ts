/**
 * Recovering a page that was loaded before a deploy.
 *
 * A deploy replaces the build's script files. A page loaded before it still
 * names the old files for everything it loads later, and the server no longer
 * has them, so that part of the page fails to load. Trying again asks for the
 * same missing file; loading the page again gets the new build.
 */
const LAST_RELOAD_KEY = "sourceweft.stale-build-reload";
const RELOAD_GAP_MS = 60_000;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

/** True for an error raised because one of the build's script files did not load. */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ChunkLoadError" ||
      /Failed to load chunk|Loading chunk \S+ failed/i.test(error.message))
  );
}

/**
 * Loads the page again, at most once a minute so a page whose files stay
 * missing shows its error instead of reloading forever. Returns whether it
 * reloaded. Nothing happens when the time of the reload cannot be kept.
 */
export function reloadForStaleBuild(
  options: {
    storage?: ReloadStorage;
    now?: number;
    reload?: () => void;
  } = {},
): boolean {
  if (typeof window === "undefined") return false;
  const now = options.now ?? Date.now();
  try {
    const storage = options.storage ?? window.sessionStorage;
    const last = Number(storage.getItem(LAST_RELOAD_KEY));
    if (now - last < RELOAD_GAP_MS) return false;
    storage.setItem(LAST_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  (options.reload ?? (() => window.location.reload()))();
  return true;
}
