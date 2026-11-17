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
import { buildIssueJql, jqlTextTerm, type JqlInput } from "./jql";
import {
  createJiraClient,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraProject,
} from "./jira-client";
import {
  CURSOR_MAX_LENGTH,
  MAX_FANOUT_SITES,
  hasJiraScope,
  invalidRequest,
} from "./shared";

type JiraClient = ReturnType<typeof createJiraClient>;

export type JiraLiveToolDeps = {
  client: JiraClient;
  atlassianConfig: AtlassianClientConfig;
};

/** Issues requested per site per page. */
const ISSUE_PAGE_SIZE = 20;
/** Comments kept per issue read: the first 20 by creation time plus the total. */
const COMMENT_LIMIT = 20;
/** The truncation cap for the one issue description body. */
const DESCRIPTION_LIMIT = 20000;
/** Per-comment body truncation cap. */
const COMMENT_BODY_LIMIT = 2000;
/** Account ids resolved per site for an assignee name. */
const ASSIGNEE_MATCH_LIMIT = 5;
/** Validated upper-cased issue key. */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/;
/** A Jira project key the agent may narrow by (contribution.ts input schema). */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

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

/** Thrown when not one selected site is reachable any more, instead of letting
 * a tool return an empty result that looks like "no matching issues". */
function noSitesReachable(): AtlassianApiError {
  return new AtlassianApiError(
    404,
    "JIRA_NOT_FOUND",
    "None of the selected Jira sites can be accessed any more. Ask the user to reconnect Jira or choose projects again.",
  );
}

/** Builds the sites note from the selected sites that could not be reached
 * (named, or by cloud id when the name is unknown) and the count of sites left
 * unsearched because of the fan-out cap. Either fact may be present; returns
 * `undefined` when nothing was dropped. */
function buildSitesNote(
  unreachable: readonly string[],
  overflowCount: number,
): string | undefined {
  const facts: string[] = [];
  if (unreachable.length > 0) {
    const noun = unreachable.length === 1 ? "site" : "sites";
    facts.push(
      `${unreachable.length} selected ${noun} can no longer be accessed: ${unreachable.join(", ")}.`,
    );
  }
  if (overflowCount > 0) {
    facts.push(
      `Only the first ${MAX_FANOUT_SITES} selected sites are searched; ${overflowCount} more were not.`,
    );
  }
  return facts.length > 0 ? facts.join(" ") : undefined;
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

type AccessibleSites = {
  kept: SiteScope[];
  /** Cloud ids of selected sites that are no longer in accessible resources (or
   * have lost the Jira read scope). */
  inaccessible: string[];
  /** Accessible selected sites dropped because of the fan-out cap. */
  overflowCount: number;
};

/** Lists the accessible sites and keeps the first {@link MAX_FANOUT_SITES}
 * selected sites that still carry the Jira read scope, in cloud-id ascending
 * order. Throws `404 JIRA_NOT_FOUND` when not one selected site is reachable,
 * rather than returning an empty result. */
async function accessibleSelectedSites(
  deps: JiraLiveToolDeps,
  accessToken: string,
  grouped: Map<string, string[]>,
): Promise<AccessibleSites> {
  const sites = await listAccessibleResources(deps.atlassianConfig, accessToken);
  const accessible = new Map(
    sites.filter(hasJiraScope).map((site) => [site.cloudId, site]),
  );
  const kept: SiteScope[] = [];
  const inaccessible: string[] = [];
  let overflowCount = 0;
  for (const [cloudId, projectIds] of grouped) {
    const site = accessible.get(cloudId);
    if (!site) {
      inaccessible.push(cloudId);
      continue;
    }
    if (kept.length >= MAX_FANOUT_SITES) {
      overflowCount += 1;
      continue;
    }
    kept.push({ cloudId, site, projectIds });
  }
  if (kept.length === 0) throw noSitesReachable();
  return { kept, inaccessible, overflowCount };
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

/** Resolves the assignee filter for one site: `me` becomes `currentUser()`;
 * any other value is resolved through the user-search endpoint to at most
 * {@link ASSIGNEE_MATCH_LIMIT} account ids. No match leaves an empty id list,
 * which `buildIssueJql` turns into a match-nothing clause. */
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

type SiteSearchOutcome =
  | { kind: "page"; page: Awaited<ReturnType<JiraClient["searchIssues"]>> }
  | { kind: "gone" };

/** Runs one site's issue search and recovers from a project Jira no longer
 * accepts. Jira answers HTTP 400 to JQL naming a project that was deleted,
 * archived or is no longer visible; the ids that no longer resolve are dropped
 * and the search is retried once with the survivors. If none resolve, the site
 * contributes nothing. If the retry is still rejected and the agent passed a
 * status or issue type, that is the likely cause and is reported; otherwise the
 * original rejection propagates. The scope ids only ever shrink, never widen. */
async function runSiteSearch(
  deps: JiraLiveToolDeps,
  accessToken: string,
  cloudId: string,
  scopeIds: string[],
  params: IssueSearchParams,
  assignee: JqlInput["assignee"],
  pageToken: string | undefined,
): Promise<SiteSearchOutcome> {
  const search = (projectIds: string[]) =>
    deps.client.searchIssues(accessToken, cloudId, {
      jql: buildIssueJql({
        projectIds,
        text: params.text,
        status: params.status,
        issueType: params.issueType,
        assignee,
        updatedWithinDays: params.updatedWithinDays,
        orderBy: params.orderBy,
      }),
      nextPageToken: pageToken,
      maxResults: ISSUE_PAGE_SIZE,
    });

  try {
    return { kind: "page", page: await search(scopeIds) };
  } catch (error) {
    if (
      !(error instanceof AtlassianApiError) ||
      error.code !== "JIRA_INVALID_REQUEST"
    ) {
      throw error;
    }
    const resolved = await deps.client.getProjectsByIds(accessToken, cloudId, scopeIds);
    const scopeSet = new Set(scopeIds);
    const survivingIds = resolved
      .map((project) => project.id)
      .filter((id) => scopeSet.has(id));
    if (survivingIds.length === 0) return { kind: "gone" };
    try {
      return { kind: "page", page: await search(survivingIds) };
    } catch (retryError) {
      if (
        retryError instanceof AtlassianApiError &&
        retryError.code === "JIRA_INVALID_REQUEST" &&
        (params.status !== undefined || params.issueType !== undefined)
      ) {
        throw invalidRequest(
          "Jira rejected the search. The status or issue type may not exist in the selected projects; use the exact names shown in Jira.",
        );
      }
      throw retryError;
    }
  }
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

  if (params.text !== undefined && jqlTextTerm(params.text) === "") {
    // Text that is only stripped characters would otherwise silently drop the
    // text filter and return all recent issues; that is an error instead.
    throw invalidRequest("The search text has no searchable words.");
  }

  const cursorSites =
    params.cursor !== undefined && params.cursor !== ""
      ? decodeSiteCursor(params.cursor, [...grouped.keys()])
      : null;

  const { kept, inaccessible, overflowCount } = await accessibleSelectedSites(
    deps,
    input.accessToken,
    grouped,
  );

  const issues: SearchIssue[] = [];
  const nextSites: Record<string, string | null> = {};
  const projectsGone: string[] = [];
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

    // Narrow by project key locally: resolve the site's selected projects and
    // keep the ids whose key the agent asked for. The key never enters JQL, so
    // an unselected key simply matches nothing on this site.
    let scopeIds = projectIds;
    if (params.projectKeys) {
      const resolved = await deps.client.getProjectsByIds(
        input.accessToken,
        cloudId,
        projectIds,
      );
      const wanted = new Set(params.projectKeys.map((key) => key.toUpperCase()));
      scopeIds = resolved
        .filter((project) => wanted.has(project.key.toUpperCase()))
        .map((project) => project.id);
      if (scopeIds.length === 0) {
        nextSites[cloudId] = null;
        continue;
      }
    }

    const assignee = await resolveAssignee(
      deps,
      input.accessToken,
      cloudId,
      params.assignee,
    );
    const outcome = await runSiteSearch(
      deps,
      input.accessToken,
      cloudId,
      scopeIds,
      params,
      assignee,
      pageToken,
    );
    if (outcome.kind === "gone") {
      projectsGone.push(site.name || cloudId);
      nextSites[cloudId] = null;
      continue;
    }
    const page = outcome.page;

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

  const note = buildSitesNote([...inaccessible, ...projectsGone], overflowCount);
  const result: Record<string, unknown> = {
    issues,
    nextCursor: anyUnfinished ? encodeSiteCursor(nextSites) : null,
  };
  if (note) result.note = note;
  return { result };
}

/** `jira.issue.read`: the key prefix is validated but not looked up; each
 * selected site (≤5, sorted) is asked for the issue and the first whose
 * `fields.project.id` is selected there is returned — out-of-scope matches and
 * not-found sites are passed over. */
async function readIssueTool(
  deps: JiraLiveToolDeps,
  input: ConnectorActionInput,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(input.config);
  const issueKey = parseIssueKey(input.request);
  const { kept, inaccessible, overflowCount } = await accessibleSelectedSites(
    deps,
    input.accessToken,
    grouped,
  );
  const note = buildSitesNote(inaccessible, overflowCount);

  for (const { cloudId, site, projectIds } of kept) {
    const detail = await deps.client.getIssue(input.accessToken, cloudId, issueKey);
    if (!detail) continue;
    if (detail.projectId === null || !projectIds.includes(detail.projectId)) {
      continue;
    }
    const result: Record<string, unknown> = {
      issue: await toIssueDetail(deps, input.accessToken, cloudId, site, detail),
    };
    if (note) result.note = note;
    return { result };
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
  const comments = commentsPage.comments.slice(0, COMMENT_LIMIT).map((comment) => {
    const body = adfToMarkdown(comment.body);
    return {
      author: comment.author,
      created: comment.created,
      body: body.slice(0, COMMENT_BODY_LIMIT),
      truncated: body.length > COMMENT_BODY_LIMIT,
    };
  });
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
    const selectedIds = new Set(projectIds);
    const resolvedIds = new Set<string>();
    for (const project of resolved) {
      // Re-check every returned project against this site's selection: a
      // provider that ignores the id filter must not leak an unselected project.
      if (!selectedIds.has(project.id)) continue;
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
