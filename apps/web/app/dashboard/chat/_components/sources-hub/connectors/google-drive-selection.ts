/**
 * Pure selection and state logic for the Google Drive connector's file list.
 * Kept free of React and SDK imports so every branch is unit-testable. The
 * server is the authority on the selection limit and the `fileIds` shape; the
 * values here drive friendly client-side messages and row states only.
 */

/** Friendly client-side cap. The backend enforces the real limit (<= 500,
 * unique, pattern-checked); this only powers the "{count} / {limit}" header and
 * the limit warning. Defined here so `apps/web` never imports the Drive
 * capability package. Keep in sync with GOOGLE_DRIVE_MAX_FILES in
 * packages/builtin-connector-google-drive/src/contribution.ts. */
export const GOOGLE_DRIVE_MAX_FILES = 500;

/** Each selected Drive file becomes a source whose externalId is this prefix
 * followed by the Drive file id. Keep in sync with the `file:` prefix in
 * packages/builtin-connector-google-drive/src/adapter.ts. */
export const GOOGLE_DRIVE_FILE_EXTERNAL_PREFIX = "file:";

export function googleDriveExternalId(fileId: string): string {
  return `${GOOGLE_DRIVE_FILE_EXTERNAL_PREFIX}${fileId}`;
}

/** Read the connector config's `fileIds`, keeping only non-empty strings. */
export function parseGoogleDriveFileIds(
  configJson: Record<string, unknown>,
): string[] {
  const raw = configJson.fileIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export type MergeGoogleDriveSelectionResult =
  | { ok: true; fileIds: string[]; added: number }
  | { ok: false; reason: "limit"; limit: number; attempted: number };

/**
 * Append newly picked ids to the current selection, preserving the current
 * order and de-duplicating. If the merged selection would exceed the limit it
 * is rejected whole rather than truncated, so the user never silently loses a
 * pick.
 */
export function mergeGoogleDriveSelection(
  current: readonly string[],
  picked: readonly string[],
): MergeGoogleDriveSelectionResult {
  const merged = [...current];
  const seen = new Set(current);
  let added = 0;
  for (const id of picked) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
      added += 1;
    }
  }
  if (merged.length > GOOGLE_DRIVE_MAX_FILES) {
    return {
      ok: false,
      reason: "limit",
      limit: GOOGLE_DRIVE_MAX_FILES,
      attempted: merged.length,
    };
  }
  return { ok: true, fileIds: merged, added };
}

/** Remove one file id from the selection, preserving the order of the rest. */
export function removeGoogleDriveFile(
  current: readonly string[],
  fileId: string,
): string[] {
  return current.filter((id) => id !== fileId);
}

/** i18n key (relative to the `dashboardSourcesHub` namespace) for a skip
 * reason. An unrecognised reason falls back to the `.unknown` key. */
export function googleDriveSkipReasonKey(reason: string): string {
  const known = new Set([
    "unsupported_type",
    "too_large",
    "needs_ocr",
    "export_too_large",
    "empty_content",
    "unreadable",
  ]);
  const suffix = known.has(reason) ? reason : "unknown";
  return `connectors.googleDrive.skipReason.${suffix}`;
}

/** i18n key for the picker error shown when a session request or the picker
 * itself fails. Unknown and absent codes fall back to the generic key. */
export function googleDrivePickerErrorKey(code: string | undefined): string {
  if (code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE") {
    return "connectors.googleDrive.pickerError.reconnect";
  }
  if (code === "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND") {
    return "connectors.googleDrive.pickerError.notFound";
  }
  return "connectors.googleDrive.pickerError.generic";
}

export type GoogleDriveFileState =
  | { kind: "skipped"; reason: string }
  | { kind: "indexed" }
  | { kind: "processing" }
  | { kind: "failed" }
  | { kind: "unavailable" }
  | { kind: "waiting" };

/** True when a run that could have seen the current selection has run: the run
 * started after the selection last changed in this session. When the selection
 * was not changed in this session (`null`), any run qualifies. */
function runCouldHaveSeenSelection(
  runStartedAt: Date | null,
  selectionChangedAt: Date | null,
): boolean {
  if (selectionChangedAt === null) {
    return true;
  }
  if (runStartedAt === null) {
    return false;
  }
  return runStartedAt.getTime() > selectionChangedAt.getTime();
}

/**
 * Decide the single state shown for one selected file, in priority order:
 *
 *  1. `skipped` — the latest sync run's skipped items name this file. This wins
 *     even over an active source, because a file that was indexed and later
 *     skipped has had its source archived; the skip is the current truth.
 *  2. the active source's own state (`indexed` / `processing` / `failed`) when a
 *     non-archived source exists for this file.
 *  3. `unavailable` — no active source and not skipped, but the latest run has
 *     finished successfully AND started after the selection last changed in this
 *     session, so reconciliation would have archived a source that was deleted
 *     in Drive or lost access.
 *  4. `waiting` — otherwise: no run yet, a run still in progress, a run that did
 *     not finish successfully, or a run that started before a file was just
 *     added, so we cannot yet say the file is gone.
 *
 * `source` is a source returned by `listSources` (archived sources are already
 * excluded upstream), or `null`/`undefined` when no active source matches.
 * `selectionChangedAt` is when this browser session last submitted an add or a
 * remove, or `null` when it has not. Known residual gap: a selection changed
 * from another browser while a run was in flight can still read `unavailable`
 * until the next sync.
 */
export function googleDriveFileState(input: {
  fileId: string;
  source: { status: string } | null | undefined;
  latestRun: {
    status: string;
    startedAt: Date | null;
    skippedItems: ReadonlyArray<{ externalId: string; reason: string }>;
  } | null;
  selectionChangedAt: Date | null;
}): GoogleDriveFileState {
  const externalId = googleDriveExternalId(input.fileId);
  const skipped = input.latestRun?.skippedItems.find(
    (entry) => entry.externalId === externalId,
  );
  if (skipped) {
    return { kind: "skipped", reason: skipped.reason };
  }
  if (input.source) {
    if (input.source.status === "indexed") {
      return { kind: "indexed" };
    }
    if (input.source.status === "failed") {
      return { kind: "failed" };
    }
    return { kind: "processing" };
  }
  if (
    input.latestRun &&
    input.latestRun.status === "succeeded" &&
    runCouldHaveSeenSelection(
      input.latestRun.startedAt,
      input.selectionChangedAt,
    )
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "waiting" };
}

/**
 * Save a new file selection and trigger a sync only if the save succeeded.
 * Returns whether the selection was saved (so the caller can record that the
 * selection changed). `save` resolves `true` on success and `false` on failure;
 * on `false` the sync is skipped.
 */
export async function commitGoogleDriveSelection(opts: {
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
