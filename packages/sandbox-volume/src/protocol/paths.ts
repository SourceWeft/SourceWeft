import { MAX_PATH_BYTES } from "./constants";

/**
 * A volume path is relative, `/`-separated, has no empty / `.` / `..` segments, no backslashes,
 * no control characters, and its first segment never starts with `.sourceweft` (the helper's
 * own state lives there and must never be synced or restored).
 */
export function isValidVolumePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\"))
    return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  if (parts[0]!.startsWith(".sourceweft")) return false;
  return true;
}

/** Byte-ordered range covering every descendant of `path`: `path/` <= key < `path0`.
 * SQL callers must use PostgreSQL text-pattern operators (~>~/~<~) or C collation,
 * never locale-aware comparison, which can include case/accent sibling paths.
 */
export function descendantRange(path: string): { from: string; to: string } {
  return { from: `${path}/`, to: `${path}0` };
}
