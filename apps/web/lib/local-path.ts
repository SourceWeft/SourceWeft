// Display helpers for directories on one of the user's computers. Every path
// here is in the wire form the desktop app and the backend exchange: absolute,
// with `/` separators on every platform (`/Users/me/work`, `C:/Users/me/work`).

const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;

/** Drops trailing separators, keeping a root (`/`, `C:/`) intact. */
function trimTrailingSeparators(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return path.startsWith("/") ? "/" : "";
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/**
 * Abbreviates the home directory of a wire-form path to `~`:
 * `/Users/<name>/…`, `/home/<name>/…` and `<drive>:/Users/<name>/…` become
 * `~/…`, the home directory itself becomes `~`. Any other path is returned
 * unchanged.
 */
export function shortenHomePath(path: string): string {
  const home = HOME.exec(path)?.[0];
  if (!home) return path;
  const rest = path.slice(home.length).replace(/\/+$/, "");
  return `~${rest}`;
}

/**
 * The directory containing a wire-form path. A root (`/`, `C:/`) is its own
 * parent; a path with no separator has none and yields an empty string.
 */
export function parentOfWirePath(path: string): string {
  const normalized = trimTrailingSeparators(path);
  const cut = normalized.lastIndexOf("/");
  if (cut < 0) return "";
  return trimTrailingSeparators(normalized.slice(0, cut + 1));
}
