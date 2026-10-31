/**
 * Paths on a local device as the backend sees them on the wire.
 *
 * A POSIX host (macOS, Linux) speaks absolute paths that start with `/`. The
 * Windows host speaks forward-slash drive paths (`C:/Users/me/...`): never a
 * backslash, never a `\\?\` or UNC prefix. Every place that validates or
 * splits a device path goes through here so both forms are handled alike.
 */

const DRIVE_PREFIX = /^[A-Za-z]:\//u;

function isDrivePath(path: string): boolean {
  return DRIVE_PREFIX.test(path);
}

/** True when any `/`-separated segment is exactly `..`. */
export function hasParentSegment(path: string): boolean {
  return path.split("/").some((part) => part === "..");
}

/**
 * Absolute path accepted from a device: POSIX `/…` or a Windows drive path
 * `X:/…`. Rejects `..` segments, a leading `//` (UNC / network root) and, for
 * drive paths, backslashes and a doubled slash after the drive. A backslash is
 * an ordinary file-name character in a POSIX path, so POSIX paths may keep it.
 */
export function isDeviceAbsolutePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (path.startsWith("/"))
    return !path.startsWith("//") && !hasParentSegment(path);
  if (isDrivePath(path))
    return (
      !path.includes("\\") &&
      !path.startsWith("//", 2) &&
      !hasParentSegment(path)
    );
  return false;
}

/**
 * `path` relative to `root`: "." for the root itself, the remainder after
 * `root/` otherwise, null when `path` is outside `root`. A drive-path root is
 * matched case-insensitively (NTFS), the remainder is returned as given; a
 * POSIX root is matched exactly.
 */
export function deviceRelative(root: string, path: string): string | null {
  if (path === root) return ".";
  const prefix = `${root}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  if (
    isDrivePath(root) &&
    path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  )
    return path.slice(prefix.length);
  if (isDrivePath(root) && path.toLowerCase() === root.toLowerCase())
    return ".";
  return null;
}

/** `base` and `segments` joined with `/`; no normalisation. */
export function joinDevicePath(base: string, ...segments: string[]): string {
  return [base, ...segments].join("/");
}

/** Last `/`-separated segment of a device path ("" after a trailing slash). */
export function deviceBasename(path: string): string | undefined {
  return path.split("/").pop();
}

/** One trailing `/` removed, if present ("/" becomes ""). */
export function trimDeviceTrailingSlash(path: string): string {
  return path.replace(/\/$/u, "");
}
