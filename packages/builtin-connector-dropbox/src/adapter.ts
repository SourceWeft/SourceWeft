import {
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
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
/** Past this many unique ids, discovery stops counting precisely and the cap
 * message reports "more than 20,000" instead of an exact count (R6). */
const COUNT_CEILING = 20000;
// Shares its character class with the selection item id pattern in
// contribution.ts; keep both in sync.
const SELECTION_ITEM_ID = new RegExp(DROPBOX_ITEM_ID_PATTERN);

export type DropboxAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

export type DropboxSelectionEntry = { id: string; kind: "file" | "folder" };

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
 * deep link in `toItem` (spec 3.5). */
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
 * Builds the discovered `ConnectorItem` for one Dropbox file entry (spec 3.5,
 * R3). `metadata` carries everything `extract` will need (Task 4) so it never
 * has to look the file up again: `handling` and `pathRoot` in particular.
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

/** Ruling A: the exact count is formatted with en-US grouping; past the
 * counting ceiling the message gives the literal text "more than 20,000"
 * instead (R6). */
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
      // Past the cap, stop building items but keep counting ids (R6).
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
        // A file selected on its own is always emitted (R4), regardless of
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
          // are dropped silently (R4).
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
    // eslint-disable-next-line @typescript-eslint/require-await -- stub for Task 4.
    async exchangeOAuthCode(
      _input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      throw new DropboxAdapterError(501, "DROPBOX_NOT_IMPLEMENTED", "Not implemented");
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- stub for Task 4.
    async refreshOAuthToken(_input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      throw new DropboxAdapterError(501, "DROPBOX_NOT_IMPLEMENTED", "Not implemented");
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
    // eslint-disable-next-line @typescript-eslint/require-await -- stub for Task 4.
    async extract(_input: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      throw new DropboxAdapterError(501, "DROPBOX_NOT_IMPLEMENTED", "Not implemented");
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- stub for Task 4.
    async executeAction(_input: ConnectorActionInput): Promise<ConnectorActionResult> {
      throw new DropboxAdapterError(501, "DROPBOX_NOT_IMPLEMENTED", "Not implemented");
    },
  };
}
