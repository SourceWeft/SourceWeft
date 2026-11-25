import type {
  ConnectorCredentialFlow,
  ConnectorManifest,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { toBackendWebDavManifest } from "./backend-manifest";
import type { DavEntry } from "./multistatus";
import { toRequestUrl } from "./paths";

/**
 * What a flavor's credential login-flow needs from the adapter: the host
 * credentialed fetch (a scope opened per call and closed in `finally`), plus
 * optional test seams for the per-request timeout and the response size cap.
 */
export type WebDavCredentialFlowDeps = {
  credentialedFetch: () => ConnectorPublicFetchScope;
  /** Test seam: per-request timeout. Defaults to the DAV request timeout. */
  requestTimeoutMs?: number;
  /** Test seam: response body ceiling. Defaults to the login-flow cap. */
  maxResponseBytes?: number;
};

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
  /** Derive the item id, canonical URI and metadata for one discovered entry,
   * or `null` when the flavor cannot assign a stable identity to it (e.g. a
   * Nextcloud file the server returned no file id for). A `null` result skips
   * the file without making the scan incomplete, exactly like an unreadable
   * one. The plain WebDAV flavor's identity is path-based and never null. */
  itemIdentity(
    entry: DavEntry,
    ctx: WebDavItemIdentityContext,
  ): WebDavItemIdentity | null;
  /** Whether a discovered file should be indexed. A false result skips the file
   * without making the scan incomplete. */
  isReadable(entry: DavEntry): boolean;
  /** Readiness-only hook: given a collection listing, return a fixed,
   * non-secret `reason` code and user-facing `message` when the server did not
   * return the properties this flavor requires (so readiness fails), or null
   * when it is satisfactory. The adapter passes both straight through as the
   * readiness result's `reason` and `message`. Never called during discovery. */
  requireProps?(
    entries: DavEntry[],
  ): { reason: string; message: string } | null;
  /** Credential login-flow factory (credential `flow: "login_flow"` only).
   * Present only on a flavor whose connector obtains its credential through a
   * server-driven browser login (Nextcloud); the adapter attaches the result as
   * `credentialFlow`. A flavor without it (plain WebDAV) yields an adapter with
   * no `credentialFlow`, which is what the bidirectional registry rule requires. */
  makeCredentialFlow?(deps: WebDavCredentialFlowDeps): ConnectorCredentialFlow;
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
