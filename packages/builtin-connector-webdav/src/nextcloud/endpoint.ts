/**
 * Builds the Nextcloud per-user WebDAV files endpoint the shared adapter talks
 * to: `<server>/remote.php/dav/files/<userId>/`. The server may carry a base
 * path (a sub-folder install, e.g. `https://host/nextcloud`), which is kept, and
 * the user id is URL-encoded as a single path segment. The backend resolves the
 * files user id (which can differ from the login name) and calls this to form
 * the stored `endpoint`.
 *
 * `userId` must be a single path segment. It is already sanitised before it gets
 * here, but this throws defensively for an empty, `.`/`..`, or separator-bearing
 * id so no future caller can build an endpoint that escapes the files root
 * (`encodeURIComponent` does not encode `.`, so `..` would otherwise survive and
 * a later `new URL()` resolution would collapse `…/files/../` outside the root).
 */
export function nextcloudEndpoint(server: string, userId: string): string {
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    userId === "." ||
    userId === ".." ||
    userId.includes("/") ||
    userId.includes("\\")
  ) {
    throw new Error("nextcloudEndpoint: userId must be a single path segment");
  }
  const base = server.replace(/\/+$/, "");
  return `${base}/remote.php/dav/files/${encodeURIComponent(userId)}/`;
}
