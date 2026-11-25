import type { WebDavFlavor } from "../flavor";
import type { DavEntry } from "../multistatus";
import { toRequestUrl } from "../paths";
import { toBackendNextcloudManifest } from "./backend-manifest";

/** Fixed, non-secret readiness message for a server that is reachable but does
 * not behave like Nextcloud (it returned no file ids). */
const NOT_NEXTCLOUD_MESSAGE =
  "This server does not look like a Nextcloud server.";

/** The permission flag Nextcloud sets when the user may read (GET) a resource. */
const READ_FLAG = "G";
/** The permission flag Nextcloud sets on a shared resource. */
const SHARED_FLAG = "S";

/** The canonical, user-facing link to a Nextcloud file by its id, used in
 * citations: `<server>/index.php/f/<fileId>`. The file id is URL-encoded as a
 * path segment (it is already constrained to a safe token at parse time, so this
 * is defensive) and the server's base path is kept. */
function canonicalFileUrl(server: string, fileId: string): string {
  const base = server.replace(/\/+$/, "");
  return `${base}/index.php/f/${encodeURIComponent(fileId)}`;
}

/**
 * The Nextcloud flavor of the shared WebDAV adapter. It reuses the whole WebDAV
 * machinery (credentialed fetch, path scope, read-only guarantee, reconciliation
 * safety, fixed errors) and only changes what is Nextcloud-specific:
 *  - requests the `oc:fileid`, `oc:permissions` and `oc:owner-id` properties;
 *  - identifies an item by its Nextcloud file id (`nc:<fileId>`), so a rename or
 *    move keeps the same id instead of looking like a delete plus an add, and
 *    links to the canonical `index.php/f/<fileId>` URL;
 *  - skips a file the user cannot read (no `G` permission flag);
 *  - fails readiness when the server returns no file id at all (so a plain
 *    WebDAV or non-Nextcloud server behind the URL is reported, not indexed with
 *    broken identities).
 */
export const nextcloudFlavor: WebDavFlavor = {
  id: "nextcloud",
  // Both connectors ship in the one `sourceweft/webdav` capability package.
  capabilityId: "sourceweft/webdav",
  actionPrefix: "nextcloud",
  errorPrefix: "NEXTCLOUD",
  getManifest: toBackendNextcloudManifest,
  extraProps: ["oc:fileid", "oc:permissions", "oc:owner-id"],

  itemIdentity(entry: DavEntry, ctx) {
    const fileId = typeof entry.fileId === "string" ? entry.fileId : null;
    const permissions =
      typeof entry.permissions === "string" ? entry.permissions : null;
    const ownerId = typeof entry.ownerId === "string" ? entry.ownerId : null;
    // A real Nextcloud file always has a file id (readiness guarantees the
    // server returns them); the path fallback only guards the anomalous file
    // that lacks one, so two such files never collide on a literal `nc:null`.
    const externalId = fileId !== null ? `nc:${fileId}` : ctx.relativePath;
    const externalUri =
      fileId !== null && ctx.server
        ? canonicalFileUrl(ctx.server, fileId)
        : toRequestUrl(ctx.endpoint, ctx.relativePath);
    return {
      externalId,
      externalUri,
      metadata: {
        // Scope, traversal and extract stay path-based for every flavor.
        path: ctx.relativePath,
        fileId,
        permissions,
        ownerId,
        shared: permissions !== null && permissions.includes(SHARED_FLAG),
        etag: entry.etag,
        contentType: entry.contentType,
        size: entry.contentLength,
      },
    };
  },

  isReadable(entry: DavEntry): boolean {
    // A missing permissions property counts as readable (the server did not
    // express a restriction); a present one must carry the read flag.
    if (entry.permissions == null) return true;
    return entry.permissions.includes(READ_FLAG);
  },

  requireProps(entries: DavEntry[]) {
    const hasFileId = entries.some((entry) => typeof entry.fileId === "string");
    return hasFileId
      ? null
      : { reason: "not_nextcloud", message: NOT_NEXTCLOUD_MESSAGE };
  },
};
