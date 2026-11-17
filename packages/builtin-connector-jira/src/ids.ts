import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  JIRA_MAX_SELECTED_ITEMS,
  JIRA_PROJECT_ID_PATTERN,
  JIRA_SITE_ID_PATTERN,
} from "./contribution";

const PROJECT_ID = new RegExp(JIRA_PROJECT_ID_PATTERN);
const SITE_ID = new RegExp(JIRA_SITE_ID_PATTERN);

export type JiraSelectionEntry = { cloudId: string; projectId: string };

/** Parses a Jira project item id (`project:<cloudId>:<projectId>`), or
 * `null` when it does not match the pattern (wrong cloud id shape,
 * non-numeric project id, wrong prefix, upper-case cloud id, …). */
export function parseProjectId(
  id: string,
): { cloudId: string; projectId: string } | null {
  if (!PROJECT_ID.test(id)) return null;
  const [, cloudId, projectId] = id.split(":");
  if (!cloudId || !projectId) return null;
  return { cloudId, projectId };
}

export function projectItemId(cloudId: string, projectId: string): string {
  return `project:${cloudId}:${projectId}`;
}

/** Parses a Jira site item id (`site:<cloudId>`), browse-only and never
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
    "JIRA_INVALID_SELECTION",
    "Invalid Jira selection",
  );
}

/**
 * Validates and normalizes the connector's stored selection
 * (`{ items: [{ id, kind }] }`). Throws `400 JIRA_INVALID_SELECTION` on any
 * malformed entry, a wrong kind, a repeated id, or more than
 * {@link JIRA_MAX_SELECTED_ITEMS} items, before any request reaches Jira. The
 * server's config schema enforces the same shape, but the adapter never
 * trusts a selection it is about to use to build Jira requests.
 */
export function parseJiraSelection(
  config: Record<string, unknown>,
): JiraSelectionEntry[] {
  const raw = config.items;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalidSelection();
  if (raw.length > JIRA_MAX_SELECTED_ITEMS) throw invalidSelection();
  const seen = new Set<string>();
  const result: JiraSelectionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw invalidSelection();
    const id = (entry as Record<string, unknown>).id;
    const kind = (entry as Record<string, unknown>).kind;
    if (kind !== "project") throw invalidSelection();
    if (typeof id !== "string") throw invalidSelection();
    const parsed = parseProjectId(id);
    if (!parsed) throw invalidSelection();
    if (seen.has(id)) throw invalidSelection();
    seen.add(id);
    result.push(parsed);
  }
  return result;
}

/** Groups a parsed selection's project ids by cloud id, in sorted
 * (ascending) cloud-id order — the order every multi-site fan-out iterates
 * sites in (Global Constraints: at most 5 sites per call, sorted by cloud
 * id). */
export function groupByCloudId(
  selection: readonly JiraSelectionEntry[],
): Map<string, string[]> {
  const byCloudId = new Map<string, string[]>();
  for (const { cloudId, projectId } of selection) {
    const projectIds = byCloudId.get(cloudId);
    if (projectIds) {
      projectIds.push(projectId);
    } else {
      byCloudId.set(cloudId, [projectId]);
    }
  }
  return new Map(
    [...byCloudId.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}
