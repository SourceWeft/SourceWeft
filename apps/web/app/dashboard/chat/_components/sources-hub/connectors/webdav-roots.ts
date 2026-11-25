/**
 * The WebDAV connector stores its configuration as `{ endpoint, roots }`, where
 * `roots` are collection paths WITH a trailing slash. The shared selection UI,
 * however, reads and writes `configJson.items` as `{ id, kind }[]`, and the
 * `webdav.browse` / `webdav.describe` actions return canonical ids WITHOUT a
 * trailing slash. These helpers bridge the two shapes in the WebDAV path only
 * (every other connector keeps using `configJson.items` unchanged):
 *
 *   roots  = normalized collection paths (trailing slash), de-duplicated, with
 *            no root nested inside another selected root, capped at
 *            {@link WEBDAV_MAX_ROOTS}.
 *   items  = `{ id: <root without trailing slash>, kind: "folder" }`.
 *
 * The path rules mirror `packages/builtin-connector-webdav/src/paths.ts`
 * (`normalizeRoot` / `isStrictDescendant`) so the client and server agree on
 * what a root is; this module imports nothing from that backend package.
 */

import type { ConnectorSelectionItem } from "@sourceweft/sdk";

/**
 * The connector types whose selection is stored as `configJson.roots`
 * (trailing-slash DAV collection paths) rather than the generic
 * `configJson.items`, and which therefore share this bridge module, the typed
 * add dialog and the roots↔items mapping. WebDAV and Nextcloud are both read
 * through the same DAV files tree, so they behave identically here; every other
 * connector keeps using `configJson.items` unchanged. One predicate replaces the
 * former `connectorType === "webdav"` checks so Nextcloud is covered without
 * touching WebDAV's behaviour.
 */
const DAV_FILES_CONNECTOR_TYPES = new Set<string>(["webdav", "nextcloud"]);

export function isDavFilesConnector(connectorType: string): boolean {
  return DAV_FILES_CONNECTOR_TYPES.has(connectorType);
}

/** Matches `MAX_ROOTS` in the WebDAV package. */
export const WEBDAV_MAX_ROOTS = 20;
/** Matches `MAX_ROOT_LENGTH` in the WebDAV package. */
const MAX_ROOT_LENGTH = 512;
/** The one kind a WebDAV selection item can have. */
const WEBDAV_SELECTION_KIND = "folder";
// eslint-disable-next-line no-control-regex -- the control range and backslash are exactly what the server refuses.
const CONTROL = /[\u0000-\u001F\u007F\\]/;

/** The segments of an already decoded path: empty and `.` segments drop
 * (`//` collapses), `..` and control characters make the whole path invalid. */
function segmentsOf(path: string): string[] | null {
  if (typeof path !== "string" || CONTROL.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments;
}

/**
 * Normalize one typed or stored path to a root: a leading slash, collapsed
 * `//`, dropped `.`, with a trailing slash (the endpoint root is `/`). Returns
 * null when the path contains `..`, a control character or is too long — the
 * same inputs the server rejects.
 */
export function normalizeWebdavRoot(path: string): string | null {
  const segments = segmentsOf(path);
  if (segments === null) return null;
  const root = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  return root.length > MAX_ROOT_LENGTH ? null : root;
}

/** A root without its trailing slash, as `webdav.browse` reports an id (the
 * endpoint root stays `/`). */
function rootToId(root: string): string {
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

/** True when `candidate` is a strictly deeper descendant of `ancestor`,
 * compared segment by segment (so `/a/bc` is NOT inside `/a/b`). */
function isStrictDescendant(ancestor: string, candidate: string): boolean {
  const a = ancestor.split("/").filter((segment) => segment !== "");
  const c = candidate.split("/").filter((segment) => segment !== "");
  if (c.length <= a.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (c[i] !== a[i]) return false;
  }
  return true;
}

/**
 * Collapse a list of normalized roots into the canonical selection the server
 * would accept: de-duplicated, with any root that is nested inside another
 * selected root removed (the ancestor already covers it), preserving order.
 */
export function canonicalizeWebdavRoots(roots: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root);
      unique.push(root);
    }
  }
  return unique.filter(
    (root) =>
      !unique.some(
        (other) => other !== root && isStrictDescendant(other, root),
      ),
  );
}

/** Read a WebDAV connector's `configJson.roots` as selection items for the
 * shared picker. Never throws; silently drops anything malformed. */
export function webdavRootsToSelectionItems(
  configJson: Record<string, unknown>,
): ConnectorSelectionItem[] {
  const raw = configJson.roots;
  if (!Array.isArray(raw)) return [];
  const normalized: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const root = normalizeWebdavRoot(value);
    if (root !== null) normalized.push(root);
  }
  return canonicalizeWebdavRoots(normalized).map((root) => ({
    id: rootToId(root),
    kind: WEBDAV_SELECTION_KIND,
  }));
}

export type WebdavRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; reason: "invalid" | "empty" | "limit" };

/**
 * Turn the shared picker's selection items back into `configJson.roots`. Each
 * id normalizes to a trailing-slash collection path; the set is de-duplicated,
 * de-nested and capped at {@link WEBDAV_MAX_ROOTS}. An empty selection is
 * rejected (the config requires at least one root).
 */
export function webdavSelectionItemsToRoots(
  items: readonly ConnectorSelectionItem[],
): WebdavRootsResult {
  return webdavRootsFromPaths(items.map((item) => item.id));
}

/**
 * Parse free-text root paths (one per line) the add dialog collects, into
 * `configJson.roots`. Blank input defaults to the whole endpoint (`/`).
 */
export function parseWebdavRootsInput(text: string): WebdavRootsResult {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: true, roots: ["/"] };
  return webdavRootsFromPaths(lines);
}

function webdavRootsFromPaths(paths: readonly string[]): WebdavRootsResult {
  if (paths.length === 0) return { ok: false, reason: "empty" };
  const normalized: string[] = [];
  for (const path of paths) {
    const root = normalizeWebdavRoot(path);
    if (root === null) return { ok: false, reason: "invalid" };
    normalized.push(root);
  }
  const roots = canonicalizeWebdavRoots(normalized);
  if (roots.length === 0) return { ok: false, reason: "empty" };
  if (roots.length > WEBDAV_MAX_ROOTS) return { ok: false, reason: "limit" };
  return { ok: true, roots };
}
