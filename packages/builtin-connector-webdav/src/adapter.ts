import {
  ConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorCredentialInput,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeItem,
  type ConnectorSelectionDescribeResult,
  type ConnectorSelectionEntry,
  type ConnectorSyncReadinessResult,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { isConnectorIndexableFile } from "@sourceweft/builtin-document-parsers/file-types";
import {
  createDavClient,
  type DavClient,
  type DavCredential,
  type DavEntry,
} from "./dav-client";
import {
  DEFAULT_DISCOVERY_LIMITS,
  discoverWebDavPages,
  type DiscoveryLimits,
} from "./discovery";
import { parseEndpoint } from "./endpoint";
import { WebDavError } from "./errors";
import { webdavFlavor, type WebDavFlavor } from "./flavor";
import { parseStoredCredential, webDavCredentialIdentity } from "./identity";
import { MAX_ROOTS } from "./limits";
import {
  isStrictDescendant,
  normalizePath,
  normalizeRoot,
  samePath,
  toExternalId,
} from "./paths";

export type WebDavAdapterInput = {
  /** A credentialed controlled-fetch scope: public HTTPS plus the deployment's
   * allowed private origins, cross-origin redirects refused. Opened per
   * operation and closed when it finishes. */
  credentialedFetch: () => ConnectorPublicFetchScope;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  /** The connector flavor: capability id, action/error prefixes, manifest,
   * extra PROPFIND properties, item identity, readability and the readiness
   * property check. Defaults to the plain WebDAV flavor, reproducing today's
   * behaviour exactly. */
  flavor?: WebDavFlavor;
  /** Test seams. */
  limits?: Partial<DiscoveryLimits>;
  now?: () => number;
};

/** The selection-contract bound on an entry/container/breadcrumb id. */
const SELECTION_ID_MAX = 512;
/** The selection-contract bound on a `detail` string. */
const DETAIL_MAX = 2048;
/** Child folders one `webdav.browse` page returns (the result's own bound). */
const BROWSE_MAX_ENTRIES = 500;
/** Ancestors one `webdav.browse` page returns (the result's own bound). */
const BROWSE_MAX_BREADCRUMBS = 50;

const CREDENTIAL_NOT_READY_MESSAGE =
  "The WebDAV username or app password was not accepted. Reconnect the connector.";
const PATH_FORBIDDEN_MESSAGE =
  "The WebDAV account is not allowed to read one of the selected folders.";
const PATH_NOT_FOUND_MESSAGE =
  "One of the selected WebDAV folders was not found.";
const CONFIG_INVALID_MESSAGE =
  "The WebDAV connector configuration is not valid.";

/**
 * An error shaped like the platform's `ConnectorError` (`statusCode`, `code`,
 * `message`), used at the adapter boundary so the orchestrator never sees a raw
 * HTTP 401 from the WebDAV layer. A rejected credential becomes a 422
 * `WEBDAV_REAUTH_REQUIRED` (the `_REAUTH_REQUIRED` suffix the platform uses to
 * recognise a reconnect condition), never a 401 that could trip a sign-out.
 * Messages are fixed and never echo the endpoint, a path or the credential.
 */
export class WebDavAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WebDavAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** A not-ready readiness result for a WebDAV-layer error, or null when the
 * error is not one this adapter can explain (it then bubbles up). */
function readinessFailure(error: unknown): ConnectorSyncReadinessResult | null {
  if (!(error instanceof WebDavError)) return null;
  switch (error.code) {
    case "WEBDAV_UNAUTHORIZED":
      return {
        ready: false,
        reason: "reauth_required",
        message: CREDENTIAL_NOT_READY_MESSAGE,
      };
    case "WEBDAV_FORBIDDEN":
      return {
        ready: false,
        reason: "path_forbidden",
        message: PATH_FORBIDDEN_MESSAGE,
      };
    case "WEBDAV_NOT_FOUND":
      return {
        ready: false,
        reason: "path_not_found",
        message: PATH_NOT_FOUND_MESSAGE,
      };
    case "WEBDAV_ENDPOINT_INVALID":
    case "WEBDAV_PATH_INVALID":
      return {
        ready: false,
        reason: "config_invalid",
        message: CONFIG_INVALID_MESSAGE,
      };
    case "WEBDAV_BLOCKED_ENDPOINT":
      return {
        ready: false,
        reason: "blocked_endpoint",
        message: error.message,
      };
    default:
      return { ready: false, reason: "unreachable", message: error.message };
  }
}

/** Parses and normalizes the non-secret config into an endpoint URL and the
 * normalized roots. Throws a fixed WebDAV error on anything malformed, and runs
 * the flavor's config-consistency guard (e.g. Nextcloud's server/endpoint
 * same-origin check) first so a tampered config fails before any request. */
function resolveConfig(
  config: Record<string, unknown>,
  flavor?: WebDavFlavor,
): {
  endpoint: URL;
  roots: string[];
} {
  flavor?.validateConfig?.(config);
  const endpoint = parseEndpoint(
    typeof config.endpoint === "string" ? config.endpoint : "",
  );
  const rawRoots = config.roots;
  if (
    !Array.isArray(rawRoots) ||
    rawRoots.length < 1 ||
    rawRoots.length > MAX_ROOTS
  ) {
    throw new WebDavError("WEBDAV_PATH_INVALID");
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawRoots) {
    if (typeof raw !== "string") throw new WebDavError("WEBDAV_PATH_INVALID");
    const root = normalizeRoot(raw);
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return { endpoint, roots };
}

const truncateDetail = (value: string): string =>
  value.length > DETAIL_MAX ? value.slice(0, DETAIL_MAX) : value;

const lastSegment = (path: string): string => {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? "";
};

const stripTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const asCollectionPath = (path: string): string =>
  path.endsWith("/") ? path : `${path}/`;

function folderEntry(externalId: string): ConnectorSelectionEntry {
  return {
    id: externalId,
    kind: "folder",
    name: lastSegment(externalId) || "/",
    detail: truncateDetail(externalId),
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

/** The ancestors strictly between the endpoint root and the container,
 * outermost first, both excluded; at most the innermost 50. */
function breadcrumbsFor(
  containerPath: string,
): Array<{ id: string; name: string }> {
  const id = stripTrailingSlash(containerPath);
  const segments = id.split("/").filter((segment) => segment !== "");
  const crumbs: Array<{ id: string; name: string }> = [];
  let accumulated = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    accumulated += `/${segments[index]}`;
    crumbs.push({ id: accumulated, name: segments[index]! });
  }
  return crumbs.slice(-BROWSE_MAX_BREADCRUMBS);
}

export function createWebdavAdapter(
  adapterInput: WebDavAdapterInput,
): ConnectorAdapter {
  const { credentialedFetch, logger } = adapterInput;
  const flavor = adapterInput.flavor ?? webdavFlavor;
  const now = adapterInput.now ?? Date.now;
  // Only a flavor that logs in through a server-driven browser flow (Nextcloud)
  // supplies this; the plain WebDAV adapter is left with no `credentialFlow`.
  const credentialFlow = flavor.makeCredentialFlow?.({ credentialedFetch });
  const limits: DiscoveryLimits = {
    ...DEFAULT_DISCOVERY_LIMITS,
    ...adapterInput.limits,
  };

  /** The reconnect condition, with the flavor's error prefix. The platform
   * still recognises the `_REAUTH_REQUIRED` suffix. */
  function reauthError(): WebDavAdapterError {
    return new WebDavAdapterError(
      422,
      `${flavor.errorPrefix}_REAUTH_REQUIRED`,
      CREDENTIAL_NOT_READY_MESSAGE,
    );
  }

  function invalidRequestError(): WebDavAdapterError {
    return new WebDavAdapterError(
      400,
      `${flavor.errorPrefix}_INVALID_REQUEST`,
      "The WebDAV action request is not valid.",
    );
  }

  /**
   * Remaps an operation error for the platform: a 401 from the WebDAV layer
   * becomes the reconnect condition; everything else (403, 404, blocked origin,
   * unreachable, bad response, an invalid path or endpoint) keeps its own fixed
   * code and non-401 status. Always throws.
   */
  function mapOperationError(error: unknown): never {
    if (error instanceof WebDavError && error.code === "WEBDAV_UNAUTHORIZED") {
      throw reauthError();
    }
    throw error;
  }

  /** Validates a browse `containerId` and returns it as a collection path
   * (trailing slash). Absent or null means the endpoint root. */
  function parseBrowseContainer(request: Record<string, unknown>): string {
    const raw = request.containerId;
    if (raw === undefined || raw === null) return "/";
    if (typeof raw !== "string") throw invalidRequestError();
    let normalized: string;
    try {
      normalized = normalizePath(raw);
    } catch {
      throw invalidRequestError();
    }
    return asCollectionPath(normalized);
  }

  /** Validates the `describe` request and returns the requested paths verbatim
   * (each a string the platform's pattern already constrained). */
  function parseDescribeIds(request: Record<string, unknown>): string[] {
    const raw = request.ids;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ROOTS) {
      throw invalidRequestError();
    }
    const ids: string[] = [];
    for (const id of raw) {
      if (typeof id !== "string") throw invalidRequestError();
      ids.push(id);
    }
    return ids;
  }

  /** Resolves the stored credential and endpoint, mapping a rejected or
   * malformed credential to the reconnect condition. */
  function resolveCredentialAndEndpoint(
    accessToken: string,
    config: Record<string, unknown>,
  ): { credential: DavCredential; endpoint: URL; roots: string[] } {
    try {
      const credential = parseStoredCredential(accessToken);
      const { endpoint, roots } = resolveConfig(config, flavor);
      return { credential, endpoint, roots };
    } catch (error) {
      mapOperationError(error);
    }
  }

  async function* pages(
    input: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    const scope = credentialedFetch();
    try {
      const { credential, endpoint, roots } = resolveCredentialAndEndpoint(
        input.accessToken,
        input.config,
      );
      const client = createDavClient({
        fetch: scope.fetch,
        endpoint,
        credential,
      });
      const server =
        typeof input.config.server === "string"
          ? input.config.server
          : undefined;
      yield* discoverWebDavPages({
        client,
        endpoint,
        roots,
        flavor,
        server,
        limits,
        now,
        logger,
      });
    } catch (error) {
      mapOperationError(error);
    } finally {
      await scope.close();
    }
  }

  async function browseAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionBrowseResult> {
    const containerPath = parseBrowseContainer(input.request);
    const scope = credentialedFetch();
    try {
      const { credential, endpoint } = resolveCredentialAndEndpoint(
        input.accessToken,
        input.config,
      );
      const client = createDavClient({
        fetch: scope.fetch,
        endpoint,
        credential,
      });
      let entries: DavEntry[];
      try {
        entries = await client.propfind(containerPath, 1);
      } catch (error) {
        mapOperationError(error);
      }
      const seen = new Set<string>();
      const folders: string[] = [];
      for (const entry of entries) {
        if (!entry.isCollection) continue;
        const externalId = toExternalId(endpoint, entry.href);
        if (externalId === null) continue;
        // Only strict descendants of the requested container: the container's
        // own self entry, a parent, a sibling or any path the server lists
        // outside it (including a `/a/bc` lookalike of `/a/b`) is dropped.
        if (!isStrictDescendant(containerPath, externalId)) continue;
        if (externalId.length > SELECTION_ID_MAX) continue;
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        folders.push(externalId);
      }
      folders.sort((a, b) =>
        lastSegment(a).localeCompare(lastSegment(b), undefined, {
          sensitivity: "base",
        }),
      );
      const outEntries = folders.slice(0, BROWSE_MAX_ENTRIES).map(folderEntry);
      const containerId = stripTrailingSlash(containerPath);
      const container = samePath(containerPath, "/")
        ? null
        : {
            id: containerId,
            kind: "folder",
            name: lastSegment(containerId) || "/",
            detail: truncateDetail(containerId),
          };
      return {
        container,
        breadcrumbs: breadcrumbsFor(containerPath),
        entries: outEntries,
        cursor: "",
        hasMore: folders.length > BROWSE_MAX_ENTRIES,
        helpLink: null,
      };
    } finally {
      await scope.close();
    }
  }

  async function describeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionDescribeResult> {
    const ids = parseDescribeIds(input.request);
    const scope = credentialedFetch();
    try {
      const { credential, endpoint } = resolveCredentialAndEndpoint(
        input.accessToken,
        input.config,
      );
      const client = createDavClient({
        fetch: scope.fetch,
        endpoint,
        credential,
      });
      const items: ConnectorSelectionDescribeItem[] = [];
      for (const rawId of ids) {
        let path: string;
        try {
          path = asCollectionPath(normalizePath(rawId));
        } catch {
          throw invalidRequestError();
        }
        let exists = true;
        let isFile = false;
        try {
          const entries = await client.propfind(path, 0);
          // A depth-0 PROPFIND describes the resource itself. Trust the
          // server's resourcetype rather than the trailing slash we appended:
          // a file answered here (as some servers do) is a file, not a folder.
          const self = entries[0];
          if (self && !self.isCollection) isFile = true;
        } catch (error) {
          if (
            error instanceof WebDavError &&
            (error.code === "WEBDAV_NOT_FOUND" ||
              error.code === "WEBDAV_FORBIDDEN")
          ) {
            exists = false;
          } else {
            mapOperationError(error);
          }
        }
        const id = stripTrailingSlash(path);
        items.push({
          id,
          kind: exists ? (isFile ? "file" : "folder") : null,
          name: exists ? lastSegment(id) || "/" : null,
          detail: exists ? truncateDetail(id) : null,
          exists,
          meta: {},
        });
      }
      return { items };
    } finally {
      await scope.close();
    }
  }

  return {
    capabilityId: flavor.capabilityId,
    getManifest: flavor.getManifest,
    ...(credentialFlow ? { credentialFlow } : {}),

    credentialIdentity(
      config: Record<string, unknown>,
      credential: ConnectorCredentialInput,
    ): string {
      return webDavCredentialIdentity(config, credential);
    },

    async checkSyncReadiness(
      input: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        const { endpoint, roots } = resolveConfig(input.config, flavor);
        const credential = parseStoredCredential(input.accessToken);
        const scope = credentialedFetch();
        try {
          const client = createDavClient({
            fetch: scope.fetch,
            endpoint,
            credential,
          });
          for (const root of roots) {
            const entries = await client.propfind(root, 0, {
              extraProps: flavor.extraProps,
            });
            // Readiness-only: a flavor may require that the server returned the
            // properties it depends on (e.g. a Nextcloud file id). This never
            // runs during discovery.
            const missing = flavor.requireProps?.(entries);
            if (missing != null) {
              return {
                ready: false,
                reason: missing.reason,
                message: missing.message,
              };
            }
          }
          return { ready: true, metadata: { rootCount: roots.length } };
        } finally {
          await scope.close();
        }
      } catch (error) {
        const result = readinessFailure(error);
        if (result) return result;
        throw error;
      }
    },

    discover(input: ConnectorDiscoverInput) {
      return (async function* () {
        for await (const page of pages(input)) {
          for (const item of page.items) yield item;
        }
      })();
    },

    discoverPages(input: ConnectorDiscoverInput) {
      return pages(input);
    },

    async extract(
      input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      const { credential, endpoint } = resolveCredentialAndEndpoint(
        input.accessToken,
        input.config,
      );
      const item = input.item;
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      const path = typeof metadata.path === "string" ? metadata.path : null;
      if (path === null) throw new ConnectorItemSkipError("unreadable");
      const fileName = item.title;
      if (!isConnectorIndexableFile(fileName, item.mimeType)) {
        throw new ConnectorItemSkipError("unsupported_type");
      }
      return {
        item,
        file: {
          fileName,
          mimeType: item.mimeType ?? "application/octet-stream",
          sizeBytes: item.sizeBytes,
          download: async ({ maxBytes }: { maxBytes: number }) => {
            const scope = credentialedFetch();
            try {
              const client = createDavClient({
                fetch: scope.fetch,
                endpoint,
                credential,
              });
              const result = await client.get(path, { maxBytes });
              // The freshly fetched bytes are always indexed. If the file
              // changed since discovery the next run sees the new etag and
              // re-extracts; a quoting/content-coding difference in the etag is
              // normalised for the content hash, so it never forces a skip.
              return Buffer.from(result.body);
            } catch (error) {
              if (error instanceof WebDavError) {
                if (error.code === "WEBDAV_TOO_LARGE") {
                  throw new ConnectorItemSkipError("too_large");
                }
                if (error.code === "WEBDAV_UNAUTHORIZED") {
                  throw reauthError();
                }
                // One file the account cannot read right now (403), that is
                // gone (404/410) or locked (423) must not fail the run and
                // block every later collection: skip just this item. A 5xx or
                // network error (WEBDAV_UNREACHABLE) and a malformed response
                // (WEBDAV_BAD_RESPONSE) still fail so the run is retried.
                if (
                  error.code === "WEBDAV_FORBIDDEN" ||
                  error.code === "WEBDAV_NOT_FOUND" ||
                  error.code === "WEBDAV_LOCKED"
                ) {
                  throw new ConnectorItemSkipError("unreadable");
                }
              }
              throw error;
            } finally {
              await scope.close();
            }
          },
        },
      };
    },

    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === `${flavor.actionPrefix}.browse`) {
        return { result: await browseAction(input) };
      }
      if (input.actionType === `${flavor.actionPrefix}.describe`) {
        return { result: await describeAction(input) };
      }
      throw new WebDavAdapterError(
        400,
        `${flavor.errorPrefix}_UNSUPPORTED_ACTION`,
        "Unsupported WebDAV action",
      );
    },
  };
}
