/**
 * Pure, connector-neutral selection and state logic for the "choose files
 * and folders" picker. Kept free of React and SDK imports (beyond types) so
 * every branch is unit-testable, and free of any single connector's name,
 * id pattern, or limit: the server is the authority on the selection limit
 * and the `items` shape (declared per connector by its manifest's
 * `ConnectorSelectionSpec`), and the values here only drive friendly
 * client-side messages and row states. Anything specific to one connector
 * (icons, the externalId a selected item maps to, counting indexed sources
 * inside a container) lives in that connector's entry in
 * `selection-presenters.ts` instead.
 */

import type { ConnectorSelectionItem, ConnectorSelectionSpec } from "@sourceweft/sdk";

function isConnectorSelectionItem(
  value: unknown,
  spec: ConnectorSelectionSpec,
): value is ConnectorSelectionItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const id = (value as Record<string, unknown>).id;
  const kind = (value as Record<string, unknown>).kind;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 512 &&
    typeof kind === "string" &&
    spec.kinds.includes(kind)
  );
}

/**
 * Read the connector config's `items`, keeping only entries with a
 * non-empty string id (<= 512 characters) and a kind still listed in the
 * manifest's selection spec. Never throws, whatever `configJson.items`
 * holds. Named differently from the backend's throwing selection validator
 * on purpose: that one is the server-side authority and rejects a malformed
 * selection outright, while this one is a display-layer reader that
 * silently drops what it cannot show.
 */
export function readSelection(
  configJson: Record<string, unknown>,
  spec: ConnectorSelectionSpec,
): ConnectorSelectionItem[] {
  const raw = configJson.items;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is ConnectorSelectionItem =>
    isConnectorSelectionItem(value, spec),
  );
}

/** Add the item if it is not already selected (by id), or remove it if it
 * is. Mirrors a checkbox toggle in the picker dialog. */
export function toggleSelection(
  current: readonly ConnectorSelectionItem[],
  item: ConnectorSelectionItem,
): ConnectorSelectionItem[] {
  if (current.some((existing) => existing.id === item.id)) {
    return current.filter((existing) => existing.id !== item.id);
  }
  return [...current, item];
}

export type MergeSelectionResult =
  | { ok: true; items: ConnectorSelectionItem[]; added: number }
  | { ok: false; reason: "limit"; limit: number; attempted: number };

/**
 * Append newly picked items to the current selection, preserving the
 * current order and de-duplicating by id. If the merged selection would
 * exceed `maxItems` it is rejected whole rather than truncated, so the user
 * never silently loses a pick.
 */
export function mergeSelection(
  current: readonly ConnectorSelectionItem[],
  picked: readonly ConnectorSelectionItem[],
  maxItems: number,
): MergeSelectionResult {
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
  if (merged.length > maxItems) {
    return {
      ok: false,
      reason: "limit",
      limit: maxItems,
      attempted: merged.length,
    };
  }
  return { ok: true, items: merged, added };
}

/** Remove one item from the selection by id, preserving the order of the
 * rest. */
export function removeSelectionItem(
  current: readonly ConnectorSelectionItem[],
  id: string,
): ConnectorSelectionItem[] {
  return current.filter((item) => item.id !== id);
}

/** i18n key (relative to the `dashboardSourcesHub` namespace) for a skip
 * reason. An unrecognised reason falls back to the `.unknown` key. Same
 * known reason set as `dropboxSkipReasonKey` / `googleDriveSkipReasonKey`. */
export function selectionSkipReasonKey(reason: string): string {
  const known = new Set([
    "unsupported_type",
    "too_large",
    "needs_ocr",
    "export_too_large",
    "empty_content",
    "unreadable",
  ]);
  const suffix = known.has(reason) ? reason : "unknown";
  return `connectors.selection.skipReason.${suffix}`;
}

/** i18n key for the error shown when a browse/search/describe/sync request
 * fails. First match wins. Unknown and absent codes fall back to the
 * generic key. */
export function selectionErrorKey(code: string | undefined): string {
  if (code === undefined) {
    return "connectors.selection.error.generic";
  }
  // The account is marked unusable, its token refresh failed, or the
  // provider refused the stored token (access revoked upstream).
  if (
    code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE" ||
    code === "CONNECTOR_REAUTH_REQUIRED" ||
    code.endsWith("_REAUTH_REQUIRED")
  ) {
    return "connectors.selection.error.reconnect";
  }
  if (code === "CONNECTOR_SELECTION_NOT_FOUND") {
    return "connectors.selection.error.notFound";
  }
  // The specific item looked up is gone, as opposed to the connector itself
  // (CONNECTOR_SELECTION_NOT_FOUND above).
  if (code.endsWith("_NOT_FOUND")) {
    return "connectors.selection.error.notFoundItem";
  }
  if (code.endsWith("_RATE_LIMITED") || code.endsWith("_UNAVAILABLE")) {
    return "connectors.selection.error.tryLater";
  }
  // The listing's cursor was reset server-side; paging from it can no
  // longer continue, so the container must be reopened from scratch.
  if (code.endsWith("_CURSOR_RESET")) {
    return "connectors.selection.error.reopen";
  }
  return "connectors.selection.error.generic";
}

/**
 * Save a new selection and trigger a sync only if the save succeeded.
 * Returns whether the selection was saved (so the caller can record that the
 * selection changed). `save` resolves `true` on success and `false` on
 * failure; on `false` the sync is skipped. `sync` is omitted for
 * tools-only connectors that have nothing to sync.
 */
export async function commitSelection(opts: {
  save: () => Promise<boolean>;
  sync?: () => void;
}): Promise<boolean> {
  const saved = await opts.save();
  if (!saved) {
    return false;
  }
  opts.sync?.();
  return true;
}
