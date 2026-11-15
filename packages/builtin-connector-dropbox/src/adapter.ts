import {
  ConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
  type ConnectorExtractedText,
  type ConnectorItem,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendDropboxManifest } from "./backend-manifest";
import { DROPBOX_ITEM_ID_PATTERN, DROPBOX_MAX_FILES } from "./contribution";
import {
  DropboxAdapterError,
  assertDropboxId,
  createDropboxClient,
  pathRootFor,
  type DropboxEntry,
} from "./dropbox-client";
import {
  isDropboxFileSupported,
  resolveDropboxFileHandling,
  type DropboxFileHandling,
} from "./file-types";

export { DropboxAdapterError } from "./dropbox-client";

const PAGE_SIZE = 50;
/** `files/list_folder`'s own cap on entries per response page (global
 * constraints: folder listing limit 2000). */
const FOLDER_LIST_LIMIT = 2000;
/** Non-recursive `list_folder` page size for the `dropbox.browse` action
 * (global constraints: browse listing limit 200). */
const BROWSE_LIST_LIMIT = 200;
/** A request body field was absent, the wrong type, or out of range for one
 * of the three internal actions. The platform does not validate action input
 * for these routes, so the adapter validates it itself before any Dropbox
 * request is made. */
const INVALID_REQUEST_MESSAGE = "Invalid Dropbox request";
/** `dropbox.describe`'s own cap on how many ids one call may request. */
const DESCRIBE_MAX_IDS = 100;
/** `dropbox.describe`'s concurrency cap on `getMetadata` calls, so up to 100
 * requested ids never fire 100 concurrent Dropbox requests at once. */
const DESCRIBE_CONCURRENCY = 8;
/** A request cursor is opaque to this adapter; only its size is bounded
 * (matches the `cursor` field's `maxLength` in contribution.ts). */
const CURSOR_MAX_LENGTH = 4096;
/** Past this many unique ids, discovery stops counting precisely and the cap
 * message reports "more than 20,000" instead of an exact count. */
const COUNT_CEILING = 20000;
// Derived from the single pattern contribution.ts also uses for configSchema.
const SELECTION_ITEM_ID = new RegExp(DROPBOX_ITEM_ID_PATTERN);

export type DropboxAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

export type DropboxSelectionEntry = { id: string; kind: "file" | "folder" };

/*
 * Browse-dialog action contract. These results are returned unchanged by the
 * backend routes `POST /connectors/:connectorId/dropbox/{browse,search,describe}`
 * and redeclared in packages/sdk/src/connectors-client.ts; keep the three in
 * step. They carry metadata only, never a token. Ids are Dropbox file ids
 * (`id:…`), stable across renames and moves, and are what the connector config
 * stores.
 */

/** One file or folder row in a `dropbox.browse`/`dropbox.search` result. */
export type DropboxBrowseEntry = {
  id: string;
  kind: "file" | "folder";
  name: string;
  /** Path as Dropbox displays it, relative to the account's root namespace
   * (the team space root for team accounts). */
  pathDisplay: string;
  /** Bytes; null for folders. */
  size: number | null;
  /** ISO 8601 timestamp; null for folders. */
  serverModified: string | null;
  /** Whether the connector can index it. Always true for folders. */
  supported: boolean;
};

export type DropboxBrowseFolder = { id: string; name: string; pathDisplay: string };

/**
 * `dropbox.browse` request `{ folderId?: "id:…" | null, cursor?: string }`.
 * Without `folderId` it lists the root. A first page carries the listed
 * folder (null for the root) and its breadcrumbs: the ancestors between the
 * root and that folder, both excluded, outermost first. A page fetched with
 * `cursor` only continues the listing, so it returns `folder: null` and
 * `breadcrumbs: []`; callers keep those from the first page and append
 * `entries`. Entries are sorted folders first, then by name, within a page.
 */
export type DropboxBrowseResult = {
  folder: DropboxBrowseFolder | null;
  breadcrumbs: Array<{ id: string; name: string }>;
  entries: DropboxBrowseEntry[];
  /** Pass back as `cursor` while `hasMore` is true. */
  cursor: string;
  hasMore: boolean;
};

/**
 * `dropbox.search` request `{ query: string (1–200 chars after trimming),
 * cursor?: string }`. Matches active files and folders by name only.
 */
export type DropboxSearchResult = {
  entries: DropboxBrowseEntry[];
  cursor: string;
  hasMore: boolean;
};

/**
 * One item of a `dropbox.describe` result. When the id no longer resolves
 * (deleted, moved out of reach, or access lost), `exists` is false and every
 * other field except `id` is null.
 */
export type DropboxDescribeItem = {
  id: string;
  kind: "file" | "folder" | null;
  name: string | null;
  pathDisplay: string | null;
  /** Lower-cased path; matches the `pathLower` stored on synced sources. */
  pathLower: string | null;
  exists: boolean;
};

/**
 * `dropbox.describe` request `{ ids: string[] }` with 1–100 ids. Items come
 * back in request order.
 */
export type DropboxDescribeResult = {
  items: DropboxDescribeItem[];
};

function invalidRequest(): DropboxAdapterError {
  return new DropboxAdapterError(400, "DROPBOX_INVALID_REQUEST", INVALID_REQUEST_MESSAGE);
}

/** Validates a `cursor` field shared by all three internal actions: absent is
 * fine (no pagination requested yet), otherwise it must be a string within
 * the declared `maxLength`. */
function parseActionCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > CURSOR_MAX_LENGTH) {
    throw invalidRequest();
  }
  return value;
}

function parseBrowseRequest(
  request: Record<string, unknown>,
): { folderId: string | null; cursor?: string } {
  const rawFolderId = request.folderId;
  let folderId: string | null = null;
  if (rawFolderId !== undefined && rawFolderId !== null) {
    if (typeof rawFolderId !== "string" || !SELECTION_ITEM_ID.test(rawFolderId)) {
      throw invalidRequest();
    }
    folderId = rawFolderId;
  }
  return { folderId, cursor: parseActionCursor(request.cursor) };
}

/** The query is validated against its 1–200 char bound only after trimming,
 * and the trimmed value is what the adapter actually sends to Dropbox. */
function parseSearchRequest(
  request: Record<string, unknown>,
): { query: string; cursor?: string } {
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") throw invalidRequest();
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > 200) throw invalidRequest();
  return { query, cursor: parseActionCursor(request.cursor) };
}

function parseDescribeRequest(request: Record<string, unknown>): { ids: string[] } {
  const rawIds = request.ids;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > DESCRIBE_MAX_IDS) {
    throw invalidRequest();
  }
  const ids: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== "string" || !SELECTION_ITEM_ID.test(id)) throw invalidRequest();
    ids.push(id);
  }
  return { ids };
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once,
 * returning results in the same order as `items` regardless of which
 * finishes first. Used to bound `dropbox.describe`'s concurrent
 * `getMetadata` calls. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Maps one listing entry to a browse/search row, or `null` for an entry
 * this adapter cannot surface (no id, or Dropbox's `deleted` tag, which
 * `search_v2`/`list_folder` should not return but a future API change
 * might). Folder entries are always `supported: true`; files defer to the
 * same extension/downloadability check discovery uses. */
function toBrowseEntry(entry: DropboxEntry): DropboxBrowseEntry | null {
  const tag = entry[".tag"];
  if (tag !== "file" && tag !== "folder") return null;
  if (typeof entry.id !== "string") return null;
  const name = entry.name ?? "";
  return {
    id: entry.id,
    kind: tag,
    name,
    pathDisplay: entry.path_display ?? "",
    size: typeof entry.size === "number" ? entry.size : null,
    serverModified: typeof entry.server_modified === "string" ? entry.server_modified : null,
    supported: tag === "folder" ? true : isDropboxFileSupported(name, entry.is_downloadable ?? true),
  };
}

function toBrowseEntries(entries: DropboxEntry[]): DropboxBrowseEntry[] {
  const mapped: DropboxBrowseEntry[] = [];
  for (const entry of entries) {
    const browseEntry = toBrowseEntry(entry);
    if (browseEntry) mapped.push(browseEntry);
  }
  // Folders first, then case-insensitive name order.
  return mapped.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Reads `handling`/`pathRoot`/`dropboxFileId` back out of the metadata
 * `toItem` (below) wrote onto a discovered `ConnectorItem`. An
 * unrecognized `handling.kind` (e.g. corrupted or future-versioned metadata)
 * is treated the same as `"unsupported"` rather than failing the extraction
 * outright. */
function handlingKindOf(metadata: Record<string, unknown>): DropboxFileHandling["kind"] {
  const handling = metadata.handling;
  if (handling && typeof handling === "object") {
    const kind = (handling as { kind?: unknown }).kind;
    if (kind === "download" || kind === "export_paper" || kind === "unsupported") {
      return kind;
    }
  }
  return "unsupported";
}

function pathRootOf(metadata: Record<string, unknown>): string | null {
  const pathRoot = metadata.pathRoot;
  return typeof pathRoot === "string" ? pathRoot : null;
}

function invalidSelection(): DropboxAdapterError {
  return new DropboxAdapterError(
    400,
    "DROPBOX_INVALID_SELECTION",
    "Invalid Dropbox selection",
  );
}

/**
 * Validates and normalizes the connector's stored selection
 * (`{ items: [{ id, kind }] }`). Throws `400 DROPBOX_INVALID_SELECTION` on
 * any malformed entry or a repeated id, before any request reaches Dropbox.
 * The server's config schema enforces the same shape, but discovery never
 * trusts a selection it is about to use to build Dropbox requests.
 */
export function parseDropboxSelection(
  config: Record<string, unknown>,
): DropboxSelectionEntry[] {
  const raw = config.items;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalidSelection();
  const seen = new Set<string>();
  const result: DropboxSelectionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw invalidSelection();
    const id = (entry as Record<string, unknown>).id;
    const kind = (entry as Record<string, unknown>).kind;
    if (typeof id !== "string" || !SELECTION_ITEM_ID.test(id)) {
      throw invalidSelection();
    }
    if (kind !== "file" && kind !== "folder") throw invalidSelection();
    if (seen.has(id)) throw invalidSelection();
    seen.add(id);
    result.push({ id, kind });
  }
  return result;
}

/** `pathDisplay`'s parent directory as a list of its own path segments
 * (the file/folder name itself is dropped), for building the `dropbox.com`
 * deep link in `toItem`. */
function parentPathSegments(pathDisplay: string): string[] {
  const segments = pathDisplay.split("/").filter((segment) => segment.length > 0);
  segments.pop();
  return segments;
}

function externalUriFor(pathDisplay: string, name: string): string {
  const encodedParent = parentPathSegments(pathDisplay)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const prefix = encodedParent ? `/${encodedParent}` : "";
  return `https://www.dropbox.com/home${prefix}?preview=${encodeURIComponent(name)}`;
}

/**
 * Builds the discovered `ConnectorItem` for one Dropbox file entry.
 * `metadata` carries everything `extract` will need so it never has to
 * look the file up again: `handling` and `pathRoot` in particular.
 */
function toItem(
  entry: DropboxEntry,
  handling: DropboxFileHandling,
  pathRoot: string | null,
): ConnectorItem {
  const fileId = assertDropboxId(entry.id);
  const name = entry.name ?? "";
  const pathDisplay = entry.path_display ?? "";
  const pathLower = entry.path_lower ?? "";
  const isPaper = handling.kind === "export_paper";
  const mimeType =
    handling.kind === "unsupported" ? "application/octet-stream" : handling.mimeType;
  return {
    externalId: `file:${fileId}`,
    externalUri: externalUriFor(pathDisplay, name),
    title: name,
    mimeType,
    sizeBytes: isPaper
      ? null
      : typeof entry.size === "number"
        ? entry.size
        : null,
    externalUpdatedAt:
      typeof entry.server_modified === "string"
        ? new Date(entry.server_modified)
        : null,
    contentHash:
      !isPaper && typeof entry.content_hash === "string" && entry.content_hash
        ? `dropbox:${entry.content_hash}`
        : null,
    metadata: {
      dropboxFileId: fileId,
      pathDisplay,
      pathLower,
      rev: entry.rev ?? null,
      handling,
      pathRoot,
    },
  };
}

/** The exact count is formatted with en-US grouping; past the
 * counting ceiling the message gives the literal text "more than 20,000"
 * instead. */
function cappedSelectionMessage(count: number): string {
  const n =
    count > COUNT_CEILING ? "more than 20,000" : count.toLocaleString("en-US");
  return `The selection has ${n} supported files; the limit is 1,000. Remove a folder or choose smaller folders.`;
}

export function createDropboxConnectorAdapter(
  config: DropboxAdapterConfig,
): ConnectorAdapter {
  const fetcher = config.fetcher ?? fetch;
  const client = createDropboxClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetcher,
  });
  const redirectUri = `${config.baseUrl}/v1/connectors/oauth/dropbox/callback`;

  async function* pages(
    input: ConnectorDiscoverInput,
  ): AsyncIterable<ConnectorDiscoveryPage> {
    const selection = parseDropboxSelection(input.config);
    if (selection.length === 0) {
      yield {
        items: [],
        continuation: null,
        checkpoint: null,
        complete: true,
        reconcileMissing: true,
      };
      return;
    }
    // Discovery always replays the whole selection from the start, ignoring
    // any stored `cursor.continuation` (same reasoning as Drive's `pages`:
    // the platform archives anything not stamped with the current run id, so
    // a "resume" that stopped short of a fresh authoritative scan would
    // archive files an earlier, interrupted run had already indexed. The
    // continuation emitted below is progress information for the platform
    // only; it is never a resume point here).

    const account = await client.getCurrentAccount(input.accessToken);
    const pathRoot = pathRootFor(account);

    const seenIds = new Set<string>();
    const itemsById = new Map<string, ConnectorItem>();

    function consider(entry: DropboxEntry): void {
      if (entry[".tag"] !== "file" || typeof entry.id !== "string") return;
      if (seenIds.has(entry.id)) return;
      seenIds.add(entry.id);
      if (seenIds.size > COUNT_CEILING) {
        throw new DropboxAdapterError(
          422,
          "DROPBOX_SELECTION_TOO_LARGE",
          cappedSelectionMessage(seenIds.size),
        );
      }
      // Past the cap, stop building items but keep counting ids.
      if (itemsById.size < DROPBOX_MAX_FILES) {
        const handling = resolveDropboxFileHandling(
          entry.name ?? "",
          entry.is_downloadable ?? true,
        );
        itemsById.set(entry.id, toItem(entry, handling, pathRoot));
      }
    }

    for (const selected of selection) {
      if (selected.kind === "file") {
        // A file selected on its own is always emitted, regardless of
        // whether it is a supported type.
        const entry = await client.getMetadata(
          input.accessToken,
          pathRoot,
          selected.id,
        );
        if (entry) consider(entry);
        continue;
      }
      let listing = await client.listFolder(input.accessToken, pathRoot, {
        path: selected.id,
        recursive: true,
        limit: FOLDER_LIST_LIMIT,
      });
      if (!listing) continue;
      while (true) {
        for (const entry of listing.entries) {
          // Inside a selected folder, unsupported or non-downloadable files
          // are dropped silently.
          if (
            entry[".tag"] === "file" &&
            isDropboxFileSupported(entry.name ?? "", entry.is_downloadable ?? true)
          ) {
            consider(entry);
          }
        }
        if (!listing.hasMore) break;
        listing = await client.listFolderContinue(
          input.accessToken,
          pathRoot,
          listing.cursor,
        );
      }
    }

    if (seenIds.size > DROPBOX_MAX_FILES) {
      throw new DropboxAdapterError(
        422,
        "DROPBOX_SELECTION_TOO_LARGE",
        cappedSelectionMessage(seenIds.size),
      );
    }

    // Only after every file and folder in the selection has been listed
    // successfully do we start yielding pages.
    const allItems = [...itemsById.values()];
    if (allItems.length === 0) {
      yield {
        items: [],
        continuation: null,
        checkpoint: null,
        complete: true,
        reconcileMissing: true,
      };
      return;
    }
    let offset = 0;
    while (offset < allItems.length) {
      const slice = allItems.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + PAGE_SIZE;
      const complete = nextOffset >= allItems.length;
      if (complete) {
        yield {
          items: slice,
          continuation: null,
          checkpoint: null,
          complete: true,
          reconcileMissing: true,
        };
      } else {
        yield {
          items: slice,
          continuation: { offset: nextOffset },
          complete: false,
          reconcileMissing: false,
        };
      }
      offset = nextOffset;
    }
  }

  /**
   * `dropbox.browse`: lists one folder (or continues a prior listing page).
   * A `cursor` page and the root page both report `folder: null,
   * breadcrumbs: []`; only a first page for a specific `folderId`
   * resolves the folder itself and its breadcrumb ancestors.
   */
  async function browseAction(input: ConnectorActionInput): Promise<DropboxBrowseResult> {
    const { folderId, cursor } = parseBrowseRequest(input.request);
    const account = await client.getCurrentAccount(input.accessToken);
    const pathRoot = pathRootFor(account);

    if (cursor !== undefined) {
      const listing = await client.listFolderContinue(input.accessToken, pathRoot, cursor);
      return {
        folder: null,
        breadcrumbs: [],
        entries: toBrowseEntries(listing.entries),
        cursor: listing.cursor,
        hasMore: listing.hasMore,
      };
    }

    const listing = await client.listFolder(input.accessToken, pathRoot, {
      path: folderId ?? "",
      recursive: false,
      limit: BROWSE_LIST_LIMIT,
    });
    if (!listing) {
      throw new DropboxAdapterError(404, "DROPBOX_NOT_FOUND", "Dropbox folder not found");
    }
    const entries = toBrowseEntries(listing.entries);

    if (folderId === null) {
      return { folder: null, breadcrumbs: [], entries, cursor: listing.cursor, hasMore: listing.hasMore };
    }

    const folderMetadata = await client.getMetadata(input.accessToken, pathRoot, folderId);
    if (!folderMetadata || typeof folderMetadata.id !== "string") {
      throw new DropboxAdapterError(404, "DROPBOX_NOT_FOUND", "Dropbox folder not found");
    }
    const pathDisplay = folderMetadata.path_display ?? "";
    const folder: DropboxBrowseFolder = {
      id: folderMetadata.id,
      name: folderMetadata.name ?? "",
      pathDisplay,
    };

    // Breadcrumbs are the ancestors strictly between the root and the
    // current folder; each id comes from a `getMetadata` lookup on the
    // ancestor's own path (not an id), because the discovered folder's
    // path_display is the only source of its ancestry.
    const breadcrumbs: Array<{ id: string; name: string }> = [];
    let ancestorPath = "";
    for (const segment of parentPathSegments(pathDisplay)) {
      ancestorPath += `/${segment}`;
      const ancestorMetadata = await client.getMetadata(input.accessToken, pathRoot, ancestorPath);
      if (ancestorMetadata && typeof ancestorMetadata.id === "string") {
        breadcrumbs.push({ id: ancestorMetadata.id, name: ancestorMetadata.name ?? segment });
      }
      // A breadcrumb whose metadata comes back null (e.g. a race with a
      // rename or delete) is omitted rather than failing the whole browse.
    }

    return { folder, breadcrumbs, entries, cursor: listing.cursor, hasMore: listing.hasMore };
  }

  /** `dropbox.search`: a `cursor` continues the prior query's results;
   * otherwise a fresh `search_v2` call is made with the trimmed query. */
  async function searchAction(input: ConnectorActionInput): Promise<DropboxSearchResult> {
    const { query, cursor } = parseSearchRequest(input.request);
    const account = await client.getCurrentAccount(input.accessToken);
    const pathRoot = pathRootFor(account);
    const listing =
      cursor !== undefined
        ? await client.searchContinue(input.accessToken, pathRoot, cursor)
        : await client.search(input.accessToken, pathRoot, query);
    return {
      entries: toBrowseEntries(listing.entries),
      cursor: listing.cursor,
      hasMore: listing.hasMore,
    };
  }

  /** `dropbox.describe`: looks up each requested id independently (order
   * preserved) and reports whether it still exists, for the settings list's
   * folder names, file counts and "no longer exists" mark. */
  async function describeAction(input: ConnectorActionInput): Promise<DropboxDescribeResult> {
    const { ids } = parseDescribeRequest(input.request);
    const account = await client.getCurrentAccount(input.accessToken);
    const pathRoot = pathRootFor(account);
    const items = await mapWithConcurrency(
      ids,
      DESCRIBE_CONCURRENCY,
      async (id): Promise<DropboxDescribeItem> => {
        const entry = await client.getMetadata(input.accessToken, pathRoot, id);
        if (!entry || entry[".tag"] === "deleted") {
          return { id, kind: null, name: null, pathDisplay: null, pathLower: null, exists: false };
        }
        return {
          id,
          kind: entry[".tag"],
          name: entry.name ?? null,
          pathDisplay: entry.path_display ?? null,
          pathLower: entry.path_lower ?? null,
          exists: true,
        };
      },
    );
    return { items };
  }

  return {
    capabilityId: "sourceweft/dropbox",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Dropbox for a code it cannot exchange.
      return toBackendDropboxManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      const token = await client.exchangeAuthorizationCode(input.code, input.redirectUri);
      const account = await client.getCurrentAccount(token.accessToken);
      return {
        ...token,
        providerAccountId: account.account_id,
        providerAccountEmail: account.email ?? null,
        displayName: account.name?.display_name ?? account.email ?? null,
      };
    },
    refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      return client.refreshAccessToken(input.refreshToken);
    },
    async *discover(
      input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      for await (const page of pages(input)) {
        for (const item of page.items) yield item;
      }
    },
    discoverPages(
      input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorDiscoveryPage> {
      return pages(input);
    },
    async extract(
      input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      const item = input.item;
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      const fileId = assertDropboxId(metadata.dropboxFileId);
      const pathRoot = pathRootOf(metadata);
      const kind = handlingKindOf(metadata);
      if (kind === "unsupported") {
        throw new ConnectorItemSkipError("unsupported_type");
      }
      if (kind === "export_paper") {
        const markdown = await client.exportPaperMarkdown(input.accessToken, pathRoot, fileId);
        if (!markdown.trim()) {
          throw new ConnectorItemSkipError("empty_content");
        }
        const content: ConnectorExtractedText = { item, contentText: markdown, markdown };
        return content;
      }
      // kind === "download": the stored bytes are returned as-is.
      return {
        item,
        file: {
          fileName: item.title,
          mimeType: item.mimeType ?? "application/octet-stream",
          sizeBytes: item.sizeBytes,
          download: ({ maxBytes }: { maxBytes: number }) =>
            client.downloadBytes(input.accessToken, pathRoot, fileId, maxBytes),
        },
      };
    },
    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === "dropbox.browse") {
        return { result: await browseAction(input) };
      }
      if (input.actionType === "dropbox.search") {
        return { result: await searchAction(input) };
      }
      if (input.actionType === "dropbox.describe") {
        return { result: await describeAction(input) };
      }
      throw new DropboxAdapterError(
        400,
        "DROPBOX_UNSUPPORTED_ACTION",
        "Unsupported Dropbox action",
      );
    },
  };
}
