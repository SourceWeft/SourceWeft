// The three agent-visible Jira live tools (`jira.issue.search`,
// `jira.issue.read`, `jira.project.list`) with scope enforcement. Scope is
// enforced twice: every JQL starts with the selected projects of a site
// (`buildIssueJql`), and every returned issue is re-checked against that site's
// selection before it leaves the adapter. The agent never supplies JQL.

import {
  adfToMarkdown,
  AtlassianApiError,
  listAccessibleResources,
  type AtlassianClientConfig,
  type AtlassianSite,
} from "@sourceweft/atlassian-client";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
} from "@sourceweft/contracts";
import { decodeSiteCursor, encodeSiteCursor } from "./cursor";
import { groupByCloudId, parseJiraSelection } from "./ids";
import { buildIssueJql, type JqlInput } from "./jql";
import {
  createJiraClient,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraProject,
} from "./jira-client";

type JiraClient = ReturnType<typeof createJiraClient>;

export type JiraLiveToolDeps = {
  client: JiraClient;
  atlassianConfig: AtlassianClientConfig;
};

/** Selection fan-out cap (Global Constraints: at most 5 sites per call, sites
 * sorted by cloud id — `groupByCloudId` already yields them in that order). */
const MAX_FANOUT_SITES = 5;
/** Issues per site per page (task brief: `searchIssues({ maxResults: 20 })`). */
const ISSUE_PAGE_SIZE = 20;
/** Comments kept per issue read (Global Constraints: the first 20 by creation
 * time plus the total count). */
const COMMENT_LIMIT = 20;
/** The one-body truncation cap for the issue description (Global Constraints). */
const DESCRIPTION_LIMIT = 20000;
/** Per-comment body truncation cap (R10). */
const COMMENT_BODY_LIMIT = 2000;
/** Account ids resolved per site for an assignee name (R8). */
const ASSIGNEE_MATCH_LIMIT = 5;
/** The OAuth scope that marks a site as a Jira site this connector may read
 * (R3: a site is included only if its scopes contain this). */
const JIRA_READ_SCOPE = "read:jira-work";
/** Matches the `cursor` field's `maxLength` declared in contribution.ts. */
const CURSOR_MAX_LENGTH = 4096;
/** Validated upper-cased issue key (task brief). */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/;
/** A Jira project key the agent may narrow by (contribution.ts input schema). */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

const SKIPPED_NOTE = "Some selected sites were skipped";

function invalidRequest(message = "Invalid Jira request"): AtlassianApiError {
  return new AtlassianApiError(400, "JIRA_INVALID_REQUEST", message);
}

function nothingSelected(): AtlassianApiError {
  return new AtlassianApiError(
    409,
    "JIRA_NOTHING_SELECTED",
    "No Jira projects are selected for this connector. Ask the user to choose projects in the connector settings.",
  );
}

function issueNotFound(): AtlassianApiError {
  return new AtlassianApiError(404, "JIRA_NOT_FOUND", "Jira issue not found");
}

function hasJiraScope(site: AtlassianSite): boolean {
  return site.scopes.includes(JIRA_READ_SCOPE);
}

/** One selected site kept for this call, with the numeric project ids selected
 * on it (non-empty: it came from the grouped selection). */
type SiteScope = {
  cloudId: string;
  site: AtlassianSite;
  projectIds: string[];
};

/** Parses the stored selection and groups it by cloud id (sorted ascending).
 * Throws `409 JIRA_NOTHING_SELECTED` on an empty selection — before any request
 * reaches Jira. */
function selectionScope(config: Record<string, unknown>): Map<string, string[]> {
  const selection = parseJiraSelection(config);
  if (selection.length === 0) throw nothingSelected();
  return groupByCloudId(selection);
}

/** Lists the accessible sites and keeps the first {@link MAX_FANOUT_SITES}
 * selected sites that still carry the Jira read scope (R3/R6 order: cloud-id
 * ascending). `note` is set when any selected site was dropped — because it is
 * no longer accessible, or because it fell past the fan-out cap. */
async function accessibleSelectedSites(
  deps: JiraLiveToolDeps,
  accessToken: string,
  grouped: Map<string, string[]>,
): Promise<{ kept: SiteScope[]; note?: string }> {
  const sites = await listAccessibleResources(deps.atlassianConfig, accessToken);
  const accessible = new Map(
    sites.filter(hasJiraScope).map((site) => [site.cloudId, site]),
  );
  const kept: SiteScope[] = [];
  let skipped = false;
  for (const [cloudId, projectIds] of grouped) {
    const site = accessible.get(cloudId);
    if (!site || kept.length >= MAX_FANOUT_SITES) {
      skipped = true;
      continue;
    }
    kept.push({ cloudId, site, projectIds });
  }
  return { kept, note: skipped ? SKIPPED_NOTE : undefined };
}

/** The issue-search parameters the agent may pass, each validated the same way
 * the contribution input schema declares (the adapter never trusts its own
 * input even though the platform validated it first). */
type IssueSearchParams = {
  text?: string;
  projectKeys?: string[];
  status?: string;
  assignee?: string;
  issueType?: string;
  updatedWithinDays?: number;
  orderBy?: "updated" | "created" | "priority";
  cursor?: string;
};

function optionalBoundedString(
  value: unknown,
  min: number,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw invalidRequest();
  }
  return value;
}

function parseIssueSearchRequest(
  request: Record<string, unknown>,
): IssueSearchParams {
  const cursor = request.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length > CURSOR_MAX_LENGTH)
  ) {
    throw invalidRequest();
  }

  let projectKeys: string[] | undefined;
  if (request.projectKeys !== undefined) {
    if (!Array.isArray(request.projectKeys) || request.projectKeys.length > 20) {
      throw invalidRequest();
    }
    projectKeys = request.projectKeys.map((key) => {
      if (typeof key !== "string" || !PROJECT_KEY_PATTERN.test(key)) {
        throw invalidRequest();
      }
      return key;
    });
  }

  let updatedWithinDays: number | undefined;
  if (request.updatedWithinDays !== undefined) {
    const value = request.updatedWithinDays;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 365
    ) {
      throw invalidRequest();
    }
    updatedWithinDays = value;
  }

  let orderBy: IssueSearchParams["orderBy"];
  if (request.orderBy !== undefined) {
    if (
      request.orderBy !== "updated" &&
      request.orderBy !== "created" &&
      request.orderBy !== "priority"
    ) {
      throw invalidRequest();
    }
    orderBy = request.orderBy;
  }

  return {
    text: optionalBoundedString(request.text, 1, 200),
    projectKeys,
    status: optionalBoundedString(request.status, 1, 100),
    assignee: optionalBoundedString(request.assignee, 1, 200),
    issueType: optionalBoundedString(request.issueType, 1, 100),
    updatedWithinDays,
    orderBy,
    cursor: cursor as string | undefined,
  };
}

function parseIssueKey(request: Record<string, unknown>): string {
  const raw = request.issueKey;
  if (typeof raw !== "string") throw invalidRequest();
  const key = raw.toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(key)) throw invalidRequest();
  return key;
}

type SearchIssue = {
  key: string;
  citationKey: string;
  summary: string;
  status: string | null;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  projectKey: string | null;
  projectName: string | null;
  updated: string | null;
  url: string;
};

function toSearchIssue(
  summary: JiraIssueSummary,
  site: AtlassianSite,
): SearchIssue {
  return {
    key: summary.key,
    citationKey: `jira:${site.cloudId}:${summary.id}`,
    summary: summary.summary,
    status: summary.status,
    issueType: summary.issueType,
    priority: summary.priority,
    assignee: summary.assignee,
    projectKey: summary.projectKey,
    projectName: summary.projectName,
    updated: summary.updated,
    url: `${site.url}/browse/${summary.key}`,
  };
}

/** Resolves the assignee filter for one site (R8): `me` becomes
 * `currentUser()`; any other value is resolved through the user-search endpoint
 * to at most {@link ASSIGNEE_MATCH_LIMIT} account ids. No match leaves an empty
 * id list, which `buildIssueJql` turns into a match-nothing clause. */
async function resolveAssignee(
  deps: JiraLiveToolDeps,
  accessToken: string,
  cloudId: string,
  assignee: string | undefined,
): Promise<JqlInput["assignee"]> {
  if (assignee === undefined) return undefined;
  if (assignee === "me") return { kind: "me" };
  const accountIds = await deps.client.findAccountIds(
    accessToken,
    cloudId,
    assignee,
    ASSIGNEE_MATCH_LIMIT,
  );
  return { kind: "accounts", accountIds };
}

/** `jira.issue.search`: structured filters only. Every site's query starts with
 * its selected project ids, and every returned issue is dropped unless its
 * `projectId` is one of those ids (out-of-scope and uncheckable issues are
 * dropped). Sites are paged independently via the multi-site cursor. */
async function searchIssuesTool(
  deps: JiraLiveToolDeps,
  input: ConnectorActionInput,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(input.config);
  const params = parseIssueSearchRequest(input.request);
  const cursorSites =
    params.cursor !== undefined && params.cursor !== ""
      ? decodeSiteCursor(params.cursor, [...grouped.keys()])
      : null;

  const { kept, note } = await accessibleSelectedSites(
    deps,
    input.accessToken,
    grouped,
  );

  const issues: SearchIssue[] = [];
  const nextSites: Record<string, string | null> = {};
  let anyUnfinished = false;

  for (const { cloudId, site, projectIds } of kept) {
    let pageToken: string | undefined;
    if (cursorSites) {
      if (!(cloudId in cursorSites)) continue;
      const token = cursorSites[cloudId];
      if (token === null) {
        nextSites[cloudId] = null;
        continue;
      }
      pageToken = token;
    }

    const assignee = await resolveAssignee(
      deps,
      input.accessToken,
      cloudId,
      params.assignee,
    );
    const jql = buildIssueJql({
      projectIds,
      text: params.text,
      projectKeys: params.projectKeys,
      status: params.status,
      issueType: params.issueType,
      assignee,
      updatedWithinDays: params.updatedWithinDays,
      orderBy: params.orderBy,
    });
    const page = await deps.client.searchIssues(input.accessToken, cloudId, {
      jql,
      nextPageToken: pageToken,
      maxResults: ISSUE_PAGE_SIZE,
    });

    const selectedProjectIds = new Set(projectIds);
    for (const summary of page.issues) {
      if (summary.projectId === null || !selectedProjectIds.has(summary.projectId)) {
        continue;
      }
      issues.push(toSearchIssue(summary, site));
    }

    if (page.nextPageToken) {
      nextSites[cloudId] = page.nextPageToken;
      anyUnfinished = true;
    } else {
      nextSites[cloudId] = null;
    }
  }

  const result: Record<string, unknown> = {
    issues,
    nextCursor: anyUnfinished ? encodeSiteCursor(nextSites) : null,
  };
  if (note) result.note = note;
  return { result };
}

/** `jira.issue.read` (R7): the key prefix is validated but not looked up; each
 * selected site (≤5, sorted) is asked for the issue and the first whose
 * `fields.project.id` is selected there is returned — out-of-scope matches and
 * not-found sites are passed over. */
async function readIssueTool(
  deps: JiraLiveToolDeps,
  input: ConnectorActionInput,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(input.config);
  const issueKey = parseIssueKey(input.request);
  const { kept } = await accessibleSelectedSites(deps, input.accessToken, grouped);

  for (const { cloudId, site, projectIds } of kept) {
    const detail = await deps.client.getIssue(input.accessToken, cloudId, issueKey);
    if (!detail) continue;
    if (detail.projectId === null || !projectIds.includes(detail.projectId)) {
      continue;
    }
    return { result: { issue: await toIssueDetail(deps, input.accessToken, cloudId, site, detail) } };
  }

  throw issueNotFound();
}

async function toIssueDetail(
  deps: JiraLiveToolDeps,
  accessToken: string,
  cloudId: string,
  site: AtlassianSite,
  detail: JiraIssueDetail,
): Promise<Record<string, unknown>> {
  const commentsPage = await deps.client.listComments(
    accessToken,
    cloudId,
    detail.key,
    COMMENT_LIMIT,
  );
  const description = adfToMarkdown(detail.description);
  const comments = commentsPage.comments.slice(0, COMMENT_LIMIT).map((comment) => ({
    author: comment.author,
    created: comment.created,
    body: adfToMarkdown(comment.body).slice(0, COMMENT_BODY_LIMIT),
  }));
  return {
    ...toSearchIssue(detail, site),
    reporter: detail.reporter,
    labels: detail.labels,
    created: detail.created,
    description: description.slice(0, DESCRIPTION_LIMIT),
    descriptionTruncated: description.length > DESCRIPTION_LIMIT,
    comments,
    commentCount: commentsPage.total,
  };
}

/** `jira.project.list`: resolves the selected project ids on each accessible
 * site (≤5, sorted). `unavailable` counts selected projects that no longer
 * resolve — because their site is gone or past the fan-out cap, or because the
 * project itself was deleted. */
async function listProjectsTool(
  deps: JiraLiveToolDeps,
  input: ConnectorActionInput,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(input.config);
  const { kept } = await accessibleSelectedSites(deps, input.accessToken, grouped);
  const keptCloudIds = new Set(kept.map((entry) => entry.cloudId));

  let unavailable = 0;
  for (const [cloudId, projectIds] of grouped) {
    if (!keptCloudIds.has(cloudId)) unavailable += projectIds.length;
  }

  const projects: Array<Record<string, unknown>> = [];
  for (const { cloudId, site, projectIds } of kept) {
    let resolved: JiraProject[];
    try {
      resolved = await deps.client.getProjectsByIds(
        input.accessToken,
        cloudId,
        projectIds,
      );
    } catch (error) {
      if (error instanceof AtlassianApiError && error.code === "JIRA_NOT_FOUND") {
        // The whole site is no longer reachable: every id under it is missing.
        resolved = [];
      } else {
        throw error;
      }
    }
    const resolvedIds = new Set<string>();
    for (const project of resolved) {
      if (resolvedIds.has(project.id)) continue;
      resolvedIds.add(project.id);
      projects.push({
        key: project.key,
        name: project.name,
        projectType: project.projectTypeKey,
        lead: project.leadName,
        url: `${site.url}/browse/${project.key}`,
        siteName: site.name,
      });
    }
    unavailable += projectIds.filter((id) => !resolvedIds.has(id)).length;
  }

  return { result: { projects, unavailable } };
}

/** Dispatches one of the three agent-visible Jira actions, or returns `null`
 * when `actionType` is not one of them (the adapter then falls through to its
 * selection actions). */
export async function executeJiraLiveTool(
  deps: JiraLiveToolDeps,
  input: ConnectorActionInput,
): Promise<ConnectorActionResult | null> {
  switch (input.actionType) {
    case "jira.issue.search":
      return searchIssuesTool(deps, input);
    case "jira.issue.read":
      return readIssueTool(deps, input);
    case "jira.project.list":
      return listProjectsTool(deps, input);
    default:
      return null;
  }
}
