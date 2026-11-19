import { AtlassianApiError, groupBySite } from "@sourceweft/atlassian-client";
import {
  CONFLUENCE_MAX_SELECTED_ITEMS,
  CONFLUENCE_PAGE_ID_PATTERN,
  CONFLUENCE_SITE_ID_PATTERN,
  CONFLUENCE_SPACE_ID_PATTERN,
} from "./contribution";

const SPACE_ID = new RegExp(CONFLUENCE_SPACE_ID_PATTERN);
const PAGE_ID = new RegExp(CONFLUENCE_PAGE_ID_PATTERN);
const SITE_ID = new RegExp(CONFLUENCE_SITE_ID_PATTERN);

export type ConfluenceSelectionKind = "space" | "page";

export type ConfluenceSelectionEntry = {
  kind: ConfluenceSelectionKind;
  cloudId: string;
  id: string;
};

function parseScopedId(
  pattern: RegExp,
  id: string,
): { cloudId: string; id: string } | null {
  if (!pattern.test(id)) return null;
  const [, cloudId, numericId] = id.split(":");
  if (!cloudId || !numericId) return null;
  return { cloudId, id: numericId };
}

/** Parses a Confluence space item id (`space:<cloudId>:<spaceId>`), or `null`
 * when it does not match the pattern (wrong cloud id shape, non-numeric space
 * id, wrong prefix, upper-case cloud id, …). */
export function parseSpaceId(
  id: string,
): { cloudId: string; id: string } | null {
  return parseScopedId(SPACE_ID, id);
}

/** Parses a Confluence page item id (`page:<cloudId>:<pageId>`), or `null`
 * when it does not match the pattern. */
export function parsePageId(
  id: string,
): { cloudId: string; id: string } | null {
  return parseScopedId(PAGE_ID, id);
}

export function spaceItemId(cloudId: string, spaceId: string): string {
  return `space:${cloudId}:${spaceId}`;
}

export function pageItemId(cloudId: string, pageId: string): string {
  return `page:${cloudId}:${pageId}`;
}

/** Parses a Confluence site item id (`site:<cloudId>`), browse-only and never
 * stored in a connector's selection. Returns the bare cloud id, or `null`
 * when it does not match the pattern. */
export function parseSiteId(id: string): string | null {
  if (!SITE_ID.test(id)) return null;
  return id.slice("site:".length);
}

export function siteItemId(cloudId: string): string {
  return `site:${cloudId}`;
}

function invalidSelection(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "CONFLUENCE_INVALID_SELECTION",
    "Invalid Confluence selection",
  );
}

/**
 * Validates and normalizes the connector's stored selection
 * (`{ items: [{ id, kind }] }`). Throws `400 CONFLUENCE_INVALID_SELECTION` on
 * any malformed entry, a kind other than `space` or `page`, an id whose prefix
 * does not match its kind, a repeated id, or more than
 * {@link CONFLUENCE_MAX_SELECTED_ITEMS} items, before any request reaches
 * Confluence. The server's config schema enforces the same shape, but the
 * adapter never trusts a selection it is about to use to build requests.
 */
export function parseConfluenceSelection(
  config: Record<string, unknown>,
): ConfluenceSelectionEntry[] {
  const raw = config.items;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalidSelection();
  if (raw.length > CONFLUENCE_MAX_SELECTED_ITEMS) throw invalidSelection();
  const seen = new Set<string>();
  const result: ConfluenceSelectionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw invalidSelection();
    const id = (entry as Record<string, unknown>).id;
    const kind = (entry as Record<string, unknown>).kind;
    if (kind !== "space" && kind !== "page") throw invalidSelection();
    if (typeof id !== "string") throw invalidSelection();
    const parsed = kind === "space" ? parseSpaceId(id) : parsePageId(id);
    if (!parsed) throw invalidSelection();
    if (seen.has(id)) throw invalidSelection();
    seen.add(id);
    result.push({ kind, cloudId: parsed.cloudId, id: parsed.id });
  }
  return result;
}

/** Groups a parsed selection's space ids and page ids by cloud id, in sorted
 * (ascending) cloud-id order — the order every multi-site fan-out iterates
 * sites in (at most 5 sites per call, sorted by cloud id). */
export function scopeBySite(
  selection: readonly ConfluenceSelectionEntry[],
): Map<string, { spaceIds: string[]; pageIds: string[] }> {
  return new Map(
    [...groupBySite(selection)].map(([cloudId, entries]) => [
      cloudId,
      {
        spaceIds: entries
          .filter((entry) => entry.kind === "space")
          .map((entry) => entry.id),
        pageIds: entries
          .filter((entry) => entry.kind === "page")
          .map((entry) => entry.id),
      },
    ]),
  );
}
