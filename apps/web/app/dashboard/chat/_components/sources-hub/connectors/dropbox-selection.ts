/**
 * Pure selection and state logic for the Dropbox connector's file/folder
 * list. Kept free of React and SDK imports so every branch is
 * unit-testable, and free of any import from the Dropbox capability
 * package: the server is the authority on the selection limit and the
 * `items` shape, and the values here only drive friendly client-side
 * messages and row states. Mirrors google-drive-selection.ts.
 */

import {
  connectorFileState,
  type ConnectorFileState,
} from "./connector-file-state";

/** Friendly client-side cap. The backend enforces the real limit (<= 500,
 * unique, pattern-checked); this only powers the "{count} / {limit}" header
 * and the limit warning. Defined here so `apps/web` never imports the
 * Dropbox capability package. Keep in sync with
 * DROPBOX_MAX_SELECTED_ITEMS in
 * packages/builtin-connector-dropbox/src/contribution.ts. */
export const DROPBOX_MAX_SELECTED_ITEMS = 500;

/** Friendly client-side figure for the discovery cap message (a folder whose
 * supported files pass this count fails to sync). Defined here so
 * `apps/web` never imports the Dropbox capability package. Keep in sync with
 * DROPBOX_MAX_FILES in
 * packages/builtin-connector-dropbox/src/contribution.ts. */
export const DROPBOX_MAX_FILES = 1000;

/** Each selected Dropbox item's id, as handed out by `dropbox.browse` /
 * `dropbox.search` and accepted back by the connector config. Keep in sync
 * with DROPBOX_ITEM_ID_PATTERN in
 * packages/builtin-connector-dropbox/src/contribution.ts. */
const DROPBOX_ITEM_ID_PATTERN = /^id:[A-Za-z0-9_-]{1,200}$/;

/** Each selected Dropbox file becomes a source whose externalId is this
 * prefix followed by the Dropbox item id (itself already `id:`-prefixed, so
 * the full externalId looks like `file:id:abc`). Keep in sync with the
 * `file:` prefix in packages/builtin-connector-dropbox/src/adapter.ts. */
const DROPBOX_FILE_EXTERNAL_PREFIX = "file:";

export function dropboxExternalId(fileId: string): string {
  return `${DROPBOX_FILE_EXTERNAL_PREFIX}${fileId}`;
}

export type DropboxSelectionItem = { id: string; kind: "file" | "folder" };

function isDropboxSelectionItem(value: unknown): value is DropboxSelectionItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const id = (value as Record<string, unknown>).id;
  const kind = (value as Record<string, unknown>).kind;
  return (
    typeof id === "string" &&
    DROPBOX_ITEM_ID_PATTERN.test(id) &&
    (kind === "file" || kind === "folder")
  );
}

/**
 * Read the connector config's `items`, keeping only well-formed entries
 * (a valid `id:`-prefixed id and a `kind` of `file` or `folder`). Named
 * differently from the capability package's throwing `parseDropboxSelection`
 * on purpose: that function is the server-side validator and rejects a
 * malformed selection outright, while this one is a display-layer reader
 * that silently drops what it cannot show.
 */
export function readDropboxSelection(
  configJson: Record<string, unknown>,
): DropboxSelectionItem[] {
  const raw = configJson.items;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isDropboxSelectionItem);
}

/** Add the item if it is not already selected (by id), or remove it if it
 * is. Mirrors a checkbox toggle in the picker dialog. */
export function toggleDropboxSelection(
  current: readonly DropboxSelectionItem[],
  item: DropboxSelectionItem,
): DropboxSelectionItem[] {
  if (current.some((existing) => existing.id === item.id)) {
    return current.filter((existing) => existing.id !== item.id);
  }
  return [...current, item];
}

export type MergeDropboxSelectionResult =
  | { ok: true; items: DropboxSelectionItem[]; added: number }
  | { ok: false; reason: "limit"; limit: number; attempted: number };

/**
 * Append newly picked items to the current selection, preserving the
 * current order and de-duplicating by id. If the merged selection would
 * exceed the limit it is rejected whole rather than truncated, so the user
 * never silently loses a pick.
 */
export function mergeDropboxSelection(
  current: readonly DropboxSelectionItem[],
  picked: readonly DropboxSelectionItem[],
): MergeDropboxSelectionResult {
  const merged = [...current];
  const seen = new Set(current.map((item) => item.id));
  let added = 0;
  for (const item of picked) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
      added += 1;
    }
  }
  if (merged.length > DROPBOX_MAX_SELECTED_ITEMS) {
    return {
      ok: false,
      reason: "limit",
      limit: DROPBOX_MAX_SELECTED_ITEMS,
      attempted: merged.length,
    };
  }
  return { ok: true, items: merged, added };
}

/** Remove one item from the selection by id, preserving the order of the
 * rest. */
export function removeDropboxItem(
  current: readonly DropboxSelectionItem[],
  id: string,
): DropboxSelectionItem[] {
  return current.filter((item) => item.id !== id);
}

/**
 * Count indexed sources whose `metadata.pathLower` sits inside the given
 * folder, i.e. starts with `folderPathLower + "/"`. Used by the settings list
 * to show how many indexed files a selected folder contributed; sources still
 * processing, failed or archived are not counted.
 */
export function dropboxFolderFileCount(input: {
  folderPathLower: string;
  sources: ReadonlyArray<{
    status: string;
    metadata: Record<string, unknown>;
  }>;
}): number {
  const prefix = `${input.folderPathLower}/`;
  return input.sources.filter((source) => {
    if (source.status !== "indexed") {
      return false;
    }
    const pathLower = source.metadata?.pathLower;
    return typeof pathLower === "string" && pathLower.startsWith(prefix);
  }).length;
}

/** i18n key (relative to the `dashboardSourcesHub` namespace) for a skip
 * reason. An unrecognised reason falls back to the `.unknown` key. Same
 * known reason set as `googleDriveSkipReasonKey`. */
export function dropboxSkipReasonKey(reason: string): string {
  const known = new Set([
    "unsupported_type",
    "too_large",
    "needs_ocr",
    "export_too_large",
    "empty_content",
    "unreadable",
  ]);
  const suffix = known.has(reason) ? reason : "unknown";
  return `connectors.dropbox.skipReason.${suffix}`;
}

/** i18n key for the error shown when a browse/search/sync request fails.
 * Unknown and absent codes fall back to the generic key. */
export function dropboxErrorKey(code: string | undefined): string {
  // The account is marked unusable, its token refresh failed, or Dropbox
  // refused the stored token (access revoked in the Dropbox account).
  if (
    code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE" ||
    code === "CONNECTOR_REAUTH_REQUIRED" ||
    code === "DROPBOX_REAUTH_REQUIRED"
  ) {
    return "connectors.dropbox.error.reconnect";
  }
  if (code === "DROPBOX_CONNECTOR_NOT_FOUND") {
    return "connectors.dropbox.error.notFound";
  }
  // The specific folder or file looked up is gone, as opposed to the
  // connector itself (DROPBOX_CONNECTOR_NOT_FOUND above).
  if (code === "DROPBOX_NOT_FOUND") {
    return "connectors.dropbox.error.notFoundItem";
  }
  if (code === "DROPBOX_RATE_LIMITED" || code === "DROPBOX_UNAVAILABLE") {
    return "connectors.dropbox.error.tryLater";
  }
  // The listing's cursor was reset server-side; paging from it can no
  // longer continue, so the folder must be reopened from scratch.
  if (code === "DROPBOX_CURSOR_RESET") {
    return "connectors.dropbox.error.reopen";
  }
  if (code === "DROPBOX_INVALID_REQUEST") {
    return "connectors.dropbox.error.generic";
  }
  return "connectors.dropbox.error.generic";
}

export type DropboxFileState = ConnectorFileState;

/**
 * Decide the single state shown for one selected Dropbox item. Same
 * four-way priority order as `googleDriveFileState`; both delegate to
 * `connectorFileState` in connector-file-state.ts so the logic stays in one
 * place while each connector keeps its own externalId prefix.
 */
export function dropboxItemState(input: {
  fileId: string;
  source: { status: string } | null | undefined;
  latestRun: {
    status: string;
    startedAt: Date | null;
    skippedItems: ReadonlyArray<{ externalId: string; reason: string }>;
  } | null;
  selectionChangedAt: Date | null;
}): DropboxFileState {
  return connectorFileState({
    externalId: dropboxExternalId(input.fileId),
    source: input.source,
    latestRun: input.latestRun,
    selectionChangedAt: input.selectionChangedAt,
  });
}

/**
 * Save a new selection and trigger a sync only if the save succeeded.
 * Returns whether the selection was saved (so the caller can record that the
 * selection changed). `save` resolves `true` on success and `false` on
 * failure; on `false` the sync is skipped.
 */
export async function commitDropboxSelection(opts: {
  save: () => Promise<boolean>;
  sync: () => void;
}): Promise<boolean> {
  const saved = await opts.save();
  if (!saved) {
    return false;
  }
  opts.sync();
  return true;
}
