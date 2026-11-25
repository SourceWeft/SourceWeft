import type { ConnectorManifest } from "@sourceweft/contracts";
import { toBackendWebDavManifest } from "./backend-manifest";
import type { DavEntry } from "./multistatus";
import { toRequestUrl } from "./paths";

/** The context a flavor gets when turning one discovered entry into an item. */
export type WebDavItemIdentityContext = {
  /** The connector endpoint (base URL). */
  endpoint: URL;
  /** The canonical server URL, when the config carries one (used for canonical
   * links by flavors whose identity is not path-based). Absent for plain
   * WebDAV. */
  server?: string;
  /** The decoded path of the entry relative to the endpoint (e.g.
   * `/Docs/a.txt`). This is what the strict-descendant and out-of-scope checks
   * use, and what extract downloads through `metadata.path`, regardless of the
   * flavor's own identity. */
  relativePath: string;
};

/** The identity a flavor assigns to one discovered item. */
export type WebDavItemIdentity = {
  externalId: string;
  externalUri: string;
  metadata: Record<string, unknown>;
};

/**
 * The small seam that turns the shared WebDAV adapter into a specific
 * connector. It carries the capability id, the action/error-code prefixes, the
 * manifest, any extra PROPFIND properties to request, and the hooks that derive
 * an item's identity, decide whether a discovered file is readable, and (only
 * at readiness) assert that the server returned the properties the flavor
 * needs. Everything else — the credentialed fetch, path handling, scope checks,
 * the read-only guarantee, reconciliation safety and the fixed error contract —
 * is shared and unchanged across flavors.
 */
export type WebDavFlavor = {
  /** Stable connector id (matches the contribution id). */
  id: string;
  /** Capability id reported on the adapter (`capabilityId`). */
  capabilityId: string;
  /** Prefix of the selection action types, e.g. `webdav` -> `webdav.browse`. */
  actionPrefix: string;
  /** Prefix of the adapter-boundary error codes, e.g. `WEBDAV` ->
   * `WEBDAV_REAUTH_REQUIRED`. The platform still recognises the
   * `_REAUTH_REQUIRED` suffix. */
  errorPrefix: string;
  /** The backend manifest for this connector. */
  getManifest(): ConnectorManifest;
  /** Extra PROPFIND property elements to request during discovery and
   * readiness (e.g. `oc:fileid`). Empty for plain WebDAV. */
  extraProps: readonly string[];
  /** Derive the item id, canonical URI and metadata for one discovered entry. */
  itemIdentity(
    entry: DavEntry,
    ctx: WebDavItemIdentityContext,
  ): WebDavItemIdentity;
  /** Whether a discovered file should be indexed. A false result skips the file
   * without making the scan incomplete. */
  isReadable(entry: DavEntry): boolean;
  /** Readiness-only hook: given a collection listing, return a fixed,
   * non-secret message when the server did not return the properties this
   * flavor requires (so readiness fails), or null when it is satisfactory.
   * Never called during discovery. */
  requireProps?(entries: DavEntry[]): string | null;
};

/**
 * The plain WebDAV flavor, reproducing today's behaviour exactly: the
 * `sourceweft/webdav` capability, `webdav.*` actions, `WEBDAV_*` error codes,
 * no extra properties, a path-based identity (externalId is the decoded
 * relative path, externalUri the rebuilt request URL, metadata `{ path, etag }`)
 * and every file readable.
 */
export const webdavFlavor: WebDavFlavor = {
  id: "webdav",
  capabilityId: "sourceweft/webdav",
  actionPrefix: "webdav",
  errorPrefix: "WEBDAV",
  getManifest: toBackendWebDavManifest,
  extraProps: [],
  itemIdentity(entry, ctx) {
    return {
      externalId: ctx.relativePath,
      externalUri: toRequestUrl(ctx.endpoint, ctx.relativePath),
      metadata: { path: ctx.relativePath, etag: entry.etag },
    };
  },
  isReadable() {
    return true;
  },
};
