/**
 * Builds the Nextcloud per-user WebDAV files endpoint the shared adapter talks
 * to: `<server>/remote.php/dav/files/<userId>/`. The server may carry a base
 * path (a sub-folder install, e.g. `https://host/nextcloud`), which is kept, and
 * the user id is URL-encoded as a single path segment. The backend resolves the
 * files user id (which can differ from the login name) and calls this to form
 * the stored `endpoint`.
 */
export function nextcloudEndpoint(server: string, userId: string): string {
  const base = server.replace(/\/+$/, "");
  return `${base}/remote.php/dav/files/${encodeURIComponent(userId)}/`;
}
