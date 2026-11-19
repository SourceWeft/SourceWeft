import {
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
  type ConnectorItem,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeItem,
  type ConnectorSelectionDescribeResult,
  type ConnectorSelectionEntry,
  type ConnectorSelectionSearchResult,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendLinearManifest } from "./backend-manifest";
import { LINEAR_ITEM_ID_PATTERN, LINEAR_MAX_SELECTED_ITEMS } from "./contribution";
import {
  IDENTITY_QUERY,
  ISSUE_QUERY,
  PROJECTS_LOOKUP_QUERY,
  PROJECTS_QUERY,
  SEARCH_ISSUES_QUERY,
  TEAMS_QUERY,
  TEAM_PROJECTS_QUERY,
} from "./documents";
import { LinearAdapterError, createLinearClient } from "./linear-client";
import {
  type LinearScope,
  issueInScope,
  issueScopeFilter,
  projectInScope,
  projectScopeFilter,
} from "./scope";

export { LinearAdapterError } from "./linear-client";

/** `linear.search`'s own cap on how many teams/projects it returns, each
 * (at most 25 matching teams followed by at most 25 matching projects, no
 * paging). `TEAMS_QUERY` has no `first` variable (it is fixed at 50 in the
 * document), so the team half of this cap is applied by slicing the result;
 * `PROJECTS_QUERY` takes `first` as a variable and is called with it
 * directly. */
const SEARCH_RESULT_LIMIT = 25;
/** `linear.describe`'s own cap on how many ids one call may request (matches
 * the contribution's `linear.describe` input schema and the selection
 * contract's `items`/`DescribeResult` bound). */
const DESCRIBE_MAX_IDS = 100;
/** `linear.describe`'s cap on `TEAMS_QUERY` requests when paging through a
 * describe's team half. `TEAMS_QUERY` is fixed at `first: 50` in the
 * document (not editable here), so a describe request for up to
 * `DESCRIBE_MAX_IDS` (100) ids can need a second page; three requests is
 * more than enough for 100 ids and bounds the worst case if Linear keeps
 * reporting `hasNextPage: true`. */
const DESCRIBE_TEAM_PAGE_LIMIT = 3;
/** A request cursor is opaque to this adapter; only its size is bounded
 * (matches the `cursor` field's `maxLength` in contribution.ts). */
const CURSOR_MAX_LENGTH = 4096;
/** `linear.search`'s own bound on the query string, after trimming (matches
 * the contribution's `linear.search` input schema). */
const SEARCH_QUERY_MAX_LENGTH = 200;
const SELECTION_ITEM_ID = new RegExp(LINEAR_ITEM_ID_PATTERN);

/** Agent-tool limits (spec "Limits"): every issue description and comment body
 * is cut at this many characters, and a tool flags when it did so. */
const MAX_TEXT_LENGTH = 20000;
/** `list_linear_projects` fetches at most this many projects in one page
 * (spec: 100 projects per list). `truncated` reports when more exist. */
const PROJECTS_LIST_LIMIT = 100;
/** Bounds on the optional `state`/`assignee` filters of `search_linear_issues`
 * (matches the contribution's `linear.issue.search` input schema). */
const ISSUE_FILTER_FIELD_MAX_LENGTH = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** `read_linear_issue` accepts a human-readable identifier such as `ENG-123`
 * (1-10 leading letters/digits, a dash, 1-9 digits) or a Linear UUID. */
const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-[0-9]{1,9}$/;
/** Note attached when an issue has more comments than the 20 fetched; it does
 * not claim which 20, only that the thread continues at the issue link. */
const COMMENTS_TRUNCATED_NOTE =
  "Showing 20 of this issue's comments; it has more. Open the issue link for the full thread.";

export type LinearAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

/*
 * Browse-dialog action contract. `linear.browse`, `linear.search` and
 * `linear.describe` return the generic selection-contract result types
 * (`ConnectorSelectionBrowseResult`, `ConnectorSelectionSearchResult`,
 * `ConnectorSelectionDescribeResult`) defined and validated in
 * `packages/contracts/src/connectors.ts`. Ids are Linear team/project uuids,
 * the same ids the connector config stores.
 *
 * `linear.browse` request `{ containerId?: "<team uuid>" | null, cursor?:
 * string }`. Without `containerId` or `cursor` it lists teams at the root.
 * `containerId` set to a team id lists that team's projects, with the team as
 * `container`. A `cursor` continues a prior page of either listing without
 * needing `containerId` again: it is opaque, base64url of `{"t": <team
 * id or null>, "a": <Linear endCursor>}`. A continuation page always reports
 * `container: null`; a team sits directly under the root, so `breadcrumbs` is
 * always `[]` and `helpLink` is always `null`. Entries are sorted by name
 * (case-insensitive) within a page.
 *
 * `linear.search` request `{ query: string (1-200 chars after trimming) }`.
 * Matches team and project names. No paging: `cursor` is always `""`,
 * `hasMore` is always `false`, and a request that itself carries a `cursor`
 * is rejected.
 *
 * `linear.describe` request `{ ids: string[] }` with 1-100 ids. Items come
 * back in request order. When an id matches neither a team nor a project,
 * `exists` is false and every other field except `id` is null.
 */

function invalidRequest(): LinearAdapterError {
  return new LinearAdapterError(400, "LINEAR_INVALID_REQUEST", "Invalid Linear request");
}

function invalidSelection(): LinearAdapterError {
  return new LinearAdapterError(400, "LINEAR_INVALID_SELECTION", "Invalid Linear selection");
}

function notFound(): LinearAdapterError {
  return new LinearAdapterError(404, "LINEAR_NOT_FOUND", "Linear team not found");
}

/** Gate shared by all three agent tools: no team and no project selected means
 * the tools would have nothing to read. Thrown before any request is built. */
function nothingSelected(): LinearAdapterError {
  return new LinearAdapterError(
    409,
    "LINEAR_NOTHING_SELECTED",
    "No Linear teams or projects are selected for this connector. Ask the user to choose them in the connector settings.",
  );
}

/** An issue that does not exist, one the token cannot see, and one outside
 * the selection all surface the same not-found, so the agent cannot probe for
 * the existence of issues outside its scope. */
function issueNotFound(): LinearAdapterError {
  return new LinearAdapterError(404, "LINEAR_NOT_FOUND", "Linear issue not found");
}

/** `client.query` can resolve `undefined` (HTTP 200 with an unparseable body)
 * or a shape missing the field a tool selected. Either is a failure, never an
 * empty result: a tool must not report `{ issues: [] }` for a response that did
 * not arrive. */
function requestFailed(): LinearAdapterError {
  return new LinearAdapterError(502, "LINEAR_REQUEST_FAILED", "Linear request failed");
}

/** Parses the stored selection and refuses an empty one (`LINEAR_NOTHING_SELECTED`,
 * before any request). The returned shape is the agent tools' `LinearScope`. */
function requireScope(config: Record<string, unknown>): LinearScope {
  const scope = parseLinearSelection(config);
  if (scope.teamIds.length === 0 && scope.projectIds.length === 0) {
    throw nothingSelected();
  }
  return scope;
}

/** Validates a GraphQL connection returned to a tool: it must be an object
 * carrying a `nodes` array and a `pageInfo` object. A missing or malformed
 * shape is `502 LINEAR_REQUEST_FAILED`, not an empty page. */
function requireConnection<N>(
  connection: { nodes?: unknown; pageInfo?: unknown } | null | undefined,
): { nodes: N[]; pageInfo: { hasNextPage?: boolean; endCursor?: string | null } } {
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    typeof connection.pageInfo !== "object" ||
    connection.pageInfo === null
  ) {
    throw requestFailed();
  }
  return connection as {
    nodes: N[];
    pageInfo: { hasNextPage?: boolean; endCursor?: string | null };
  };
}

/**
 * Validates and normalizes the connector's stored selection (`{ items: [{
 * id, kind }] }`), splitting it into team ids and project ids. Throws `400
 * LINEAR_INVALID_SELECTION` on any malformed entry, an unknown kind, a
 * repeated id, or more than `LINEAR_MAX_SELECTED_ITEMS` items. A missing
 * `items` is an empty selection. The server's config schema enforces the
 * same shape, but callers building Linear requests from a stored selection
 * never trust it blindly.
 */
export function parseLinearSelection(
  config: Record<string, unknown>,
): { teamIds: string[]; projectIds: string[] } {
  const raw = config.items;
  if (raw === undefined) return { teamIds: [], projectIds: [] };
  if (!Array.isArray(raw) || raw.length > LINEAR_MAX_SELECTED_ITEMS) {
    throw invalidSelection();
  }
  const seen = new Set<string>();
  const teamIds: string[] = [];
  const projectIds: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw invalidSelection();
    const id = (entry as Record<string, unknown>).id;
    const kind = (entry as Record<string, unknown>).kind;
    if (typeof id !== "string" || !SELECTION_ITEM_ID.test(id)) {
      throw invalidSelection();
    }
    if (kind !== "team" && kind !== "project") throw invalidSelection();
    if (seen.has(id)) throw invalidSelection();
    seen.add(id);
    if (kind === "team") teamIds.push(id);
    else projectIds.push(id);
  }
  return { teamIds, projectIds };
}

/** Validates a `cursor` field shared by `linear.browse` and `linear.search`:
 * absent is fine, otherwise it must be a string within the declared
 * `maxLength`. Does not decode it. */
function parseActionCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > CURSOR_MAX_LENGTH) {
    throw invalidRequest();
  }
  return value;
}

function parseBrowseRequest(
  request: Record<string, unknown>,
): { containerId: string | null; cursor?: string } {
  const rawContainerId = request.containerId;
  let containerId: string | null = null;
  if (rawContainerId !== undefined && rawContainerId !== null) {
    if (typeof rawContainerId !== "string" || !SELECTION_ITEM_ID.test(rawContainerId)) {
      throw invalidRequest();
    }
    containerId = rawContainerId;
  }
  return { containerId, cursor: parseActionCursor(request.cursor) };
}

type BrowseCursor = { teamId: string | null; after: string };

/** Opaque to callers; base64url of `{"t": <teamId or null>, "a": <Linear
 * endCursor>}`. */
function encodeBrowseCursor(teamId: string | null, after: string): string {
  return Buffer.from(JSON.stringify({ t: teamId, a: after }), "utf8").toString("base64url");
}

/** Throws `400 LINEAR_INVALID_REQUEST` when `cursor` does not decode to the
 * `{t, a}` shape of the browse cursor. */
function decodeBrowseCursor(cursor: string): BrowseCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidRequest();
  }
  if (typeof decoded !== "object" || decoded === null) throw invalidRequest();
  const t = (decoded as Record<string, unknown>).t;
  const a = (decoded as Record<string, unknown>).a;
  if ((t !== null && typeof t !== "string") || typeof a !== "string") {
    throw invalidRequest();
  }
  // The team id is checked like `containerId`: a cursor carrying any other
  // team value is rejected before any request is made.
  if (typeof t === "string" && !SELECTION_ITEM_ID.test(t)) {
    throw invalidRequest();
  }
  return { teamId: t, after: a };
}

/** The query is validated against its 1-200 char bound only after trimming,
 * and a request that itself carries a `cursor` is rejected outright
 * (`linear.search` never paginates). */
function parseSearchRequest(request: Record<string, unknown>): { query: string } {
  if ("cursor" in request) throw invalidRequest();
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") throw invalidRequest();
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX_LENGTH) throw invalidRequest();
  return { query };
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

/** Validates a `search_linear_issues` request (defence in depth: the backend
 * already checks it against the contribution's input schema). The query is
 * bounded after trimming; every optional filter is bounds-checked; the cursor
 * reuses the shared `parseActionCursor`. */
function parseSearchIssuesRequest(request: Record<string, unknown>): {
  query: string;
  state?: string;
  assignee?: string;
  updatedWithinDays?: number;
  after?: string;
} {
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") throw invalidRequest();
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX_LENGTH) throw invalidRequest();

  let state: string | undefined;
  if (request.state !== undefined) {
    if (typeof request.state !== "string") throw invalidRequest();
    state = request.state.trim();
    if (state.length < 1 || state.length > ISSUE_FILTER_FIELD_MAX_LENGTH) throw invalidRequest();
  }

  let assignee: string | undefined;
  if (request.assignee !== undefined) {
    if (typeof request.assignee !== "string") throw invalidRequest();
    assignee = request.assignee.trim();
    if (assignee.length < 1 || assignee.length > ISSUE_FILTER_FIELD_MAX_LENGTH) {
      throw invalidRequest();
    }
  }

  let updatedWithinDays: number | undefined;
  if (request.updatedWithinDays !== undefined) {
    const value = request.updatedWithinDays;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 365) {
      throw invalidRequest();
    }
    updatedWithinDays = value;
  }

  return { query, state, assignee, updatedWithinDays, after: parseActionCursor(request.cursor) };
}

/** Validates a `read_linear_issue` request: the id must be a human-readable
 * identifier (`ENG-123`) or a Linear UUID. Anything else — a value with a
 * space or a slash — is rejected before any request. */
function parseReadIssueRequest(request: Record<string, unknown>): { id: string } {
  const rawId = request.id;
  if (typeof rawId !== "string") throw invalidRequest();
  if (!ISSUE_IDENTIFIER_PATTERN.test(rawId) && !SELECTION_ITEM_ID.test(rawId)) {
    throw invalidRequest();
  }
  return { id: rawId };
}

/** Cuts text at `MAX_TEXT_LENGTH` and reports whether it did. */
function cutText(text: string): { value: string; truncated: boolean } {
  if (text.length > MAX_TEXT_LENGTH) {
    return { value: text.slice(0, MAX_TEXT_LENGTH), truncated: true };
  }
  return { value: text, truncated: false };
}

/** The issue fields `SEARCH_ISSUES_QUERY` selects (also the summary half of
 * `ISSUE_QUERY`). `team` is non-null so the record satisfies `issueInScope`;
 * the mappers below still read every nullable field defensively. */
type RawIssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priorityLabel: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
};

type RawIssueDetail = RawIssueNode & {
  description: string | null;
  createdAt: string;
  labels: { nodes: Array<{ name: string } | null> };
  comments: {
    nodes: Array<{ body: string | null; createdAt: string; user: { name: string } | null }>;
    pageInfo: { hasNextPage?: boolean };
  };
};

type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string } | null;
  assignee: string | null;
  priority: string;
  team: { key: string; name: string };
  project: string | null;
  updatedAt: string;
};

function toIssueSummary(node: RawIssueNode): LinearIssueSummary {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state ? { name: node.state.name, type: node.state.type } : null,
    assignee: node.assignee?.name ?? null,
    priority: node.priorityLabel,
    team: { key: node.team?.key, name: node.team?.name },
    project: node.project?.name ?? null,
    updatedAt: node.updatedAt,
  };
}

/** The project fields `PROJECTS_QUERY` selects. `teams.nodes` is non-null so
 * the record satisfies `projectInScope`; the mapper reads keys defensively. */
type RawProjectNode = {
  id: string;
  name: string;
  url: string;
  progress: number | null;
  targetDate: string | null;
  status: { name: string } | null;
  lead: { name: string } | null;
  teams: { nodes: Array<{ id: string; name: string; key: string }> };
};

type LinearProjectSummary = {
  id: string;
  name: string;
  status: string | null;
  lead: string | null;
  progress: number | null;
  targetDate: string | null;
  url: string;
  teams: string[];
};

function toProjectSummary(node: RawProjectNode): LinearProjectSummary {
  const teams = Array.isArray(node.teams?.nodes)
    ? node.teams.nodes
        .map((team) => team?.key)
        .filter((key): key is string => typeof key === "string")
    : [];
  return {
    id: node.id,
    name: node.name,
    status: node.status?.name ?? null,
    lead: node.lead?.name ?? null,
    progress: typeof node.progress === "number" ? node.progress : null,
    targetDate: node.targetDate ?? null,
    url: node.url,
    teams,
  };
}

type LinearTeamNode = { id: string; name: string; key: string };
type LinearProjectNode = {
  id: string;
  name: string;
  status?: { name: string } | null;
};

function sortByName<T extends { name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function teamToEntry(team: LinearTeamNode): ConnectorSelectionEntry {
  return {
    id: team.id,
    kind: "team",
    name: team.name,
    detail: team.key,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

function projectToEntry(project: LinearProjectNode): ConnectorSelectionEntry {
  return {
    id: project.id,
    kind: "project",
    name: project.name,
    detail: project.status?.name ?? null,
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

export function createLinearConnectorAdapter(
  config: LinearAdapterConfig,
): ConnectorAdapter {
  const fetcher = config.fetcher ?? fetch;
  const client = createLinearClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetcher,
  });
  const redirectUri = `${config.baseUrl}/v1/connectors/oauth/linear/callback`;

  /** Without both credentials no token call can succeed, so fail with
   * `LINEAR_UNAVAILABLE` before reaching Linear rather than sending a request
   * that is guaranteed to be rejected. */
  function requireConfiguredClient(): void {
    if (!config.clientId || !config.clientSecret) {
      throw new LinearAdapterError(503, "LINEAR_UNAVAILABLE", "Linear is unavailable");
    }
  }

  /** Root teams page: `after` continues a prior page (continuation pages
   * report `container: null`); omitted, it is the listing's first page
   * (which additionally reports `container: null`, since a team sits
   * directly under the root). */
  async function browseTeamsPage(
    accessToken: string,
    after: string | undefined,
  ): Promise<ConnectorSelectionBrowseResult> {
    const data = await client.query<{
      teams: {
        nodes: LinearTeamNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    }>(accessToken, TEAMS_QUERY, { after, filter: undefined });
    return {
      container: null,
      breadcrumbs: [],
      entries: sortByName(data.teams.nodes.map(teamToEntry)),
      cursor: encodeBrowseCursor(null, data.teams.pageInfo.endCursor),
      hasMore: data.teams.pageInfo.hasNextPage,
      helpLink: null,
    };
  }

  /** A team's projects page: `after` continues a prior page. `isFirstPage`
   * controls whether the team itself is resolved and returned as
   * `container` (a continuation page always reports `container: null`). */
  async function browseTeamProjectsPage(
    accessToken: string,
    teamId: string,
    after: string | undefined,
    isFirstPage: boolean,
  ): Promise<ConnectorSelectionBrowseResult> {
    const data = await client.query<{
      team: {
        id: string;
        name: string;
        key: string;
        projects: {
          nodes: LinearProjectNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      } | null;
    }>(accessToken, TEAM_PROJECTS_QUERY, { id: teamId, after });
    const team = data.team;
    if (!team) throw notFound();
    return {
      container: isFirstPage
        ? { id: team.id, kind: "team", name: team.name, detail: team.key }
        : null,
      breadcrumbs: [],
      entries: sortByName(team.projects.nodes.map(projectToEntry)),
      cursor: encodeBrowseCursor(teamId, team.projects.pageInfo.endCursor),
      hasMore: team.projects.pageInfo.hasNextPage,
      helpLink: null,
    };
  }

  /** `linear.browse`: lists teams at the root, or one team's projects, or
   * continues either listing via an opaque cursor. The request is
   * validated, and a cursor decoded, before any Linear request is made. */
  async function browseAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionBrowseResult> {
    const { containerId, cursor } = parseBrowseRequest(input.request);
    if (cursor !== undefined) {
      const decoded = decodeBrowseCursor(cursor);
      if (decoded.teamId === null) {
        return browseTeamsPage(input.accessToken, decoded.after);
      }
      return browseTeamProjectsPage(input.accessToken, decoded.teamId, decoded.after, false);
    }
    if (containerId === null) {
      return browseTeamsPage(input.accessToken, undefined);
    }
    return browseTeamProjectsPage(input.accessToken, containerId, undefined, true);
  }

  /** `linear.search`: matches team and project names in parallel, teams
   * (at most 25) then projects (at most 25), never paginated. */
  async function searchAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionSearchResult> {
    const { query } = parseSearchRequest(input.request);
    const nameFilter = { name: { containsIgnoreCase: query } };
    const [teamsData, projectsData] = await Promise.all([
      client.query<{ teams: { nodes: LinearTeamNode[] } }>(input.accessToken, TEAMS_QUERY, {
        after: undefined,
        filter: nameFilter,
      }),
      client.query<{ projects: { nodes: LinearProjectNode[] } }>(
        input.accessToken,
        PROJECTS_LOOKUP_QUERY,
        { first: SEARCH_RESULT_LIMIT, filter: nameFilter },
      ),
    ]);
    const teamEntries = teamsData.teams.nodes.slice(0, SEARCH_RESULT_LIMIT).map(teamToEntry);
    const projectEntries = projectsData.projects.nodes.map(projectToEntry);
    return {
      entries: [...teamEntries, ...projectEntries],
      cursor: "",
      hasMore: false,
    };
  }

  /** `TEAMS_QUERY` is fixed at `first: 50` in the document, so describing up
   * to `DESCRIBE_MAX_IDS` ids pages through it with the same `id in ids`
   * filter, following `pageInfo.hasNextPage`/`endCursor` via `after`, up to
   * `DESCRIBE_TEAM_PAGE_LIMIT` requests. If a page at that limit still
   * reports `hasNextPage: true`, paging stops and only what was fetched so
   * far is used (100 ids cannot need more than the limit allows). */
  async function fetchDescribeTeamNodes(
    accessToken: string,
    filter: { id: { in: string[] } },
  ): Promise<LinearTeamNode[]> {
    const nodes: LinearTeamNode[] = [];
    let after: string | undefined;
    for (let page = 0; page < DESCRIBE_TEAM_PAGE_LIMIT; page += 1) {
      const data = await client.query<{
        teams: {
          nodes: LinearTeamNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }>(accessToken, TEAMS_QUERY, { after, filter });
      nodes.push(...data.teams.nodes);
      if (!data.teams.pageInfo.hasNextPage) break;
      after = data.teams.pageInfo.endCursor;
    }
    return nodes;
  }

  /** `linear.describe`: looks up every requested id as a team or a project,
   * in parallel, and reports each in request order. An id matching neither
   * comes back `exists: false` with every other field `null`. */
  async function describeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionDescribeResult> {
    const { ids } = parseDescribeRequest(input.request);
    const idFilter = { id: { in: ids } };
    const [teamNodes, projectsData] = await Promise.all([
      fetchDescribeTeamNodes(input.accessToken, idFilter),
      client.query<{ projects: { nodes: LinearProjectNode[] } }>(
        input.accessToken,
        PROJECTS_LOOKUP_QUERY,
        { first: DESCRIBE_MAX_IDS, filter: idFilter },
      ),
    ]);
    const teamsById = new Map(teamNodes.map((team) => [team.id, team]));
    const projectsById = new Map(projectsData.projects.nodes.map((project) => [project.id, project]));
    const items: ConnectorSelectionDescribeItem[] = ids.map((id) => {
      const team = teamsById.get(id);
      if (team) {
        return { id, kind: "team", name: team.name, detail: team.key, exists: true, meta: {} };
      }
      const project = projectsById.get(id);
      if (project) {
        return {
          id,
          kind: "project",
          name: project.name,
          detail: project.status?.name ?? null,
          exists: true,
          meta: {},
        };
      }
      return { id, kind: null, name: null, detail: null, exists: false, meta: {} };
    });
    return { items };
  }

  /** `search_linear_issues`: full-text search narrowed to the selection. The
   * scope filter is sent to Linear *and* re-applied to every returned node, so
   * a record Linear returns outside the selection is dropped, never surfaced.
   * Checks run in order: selection gate, then request validation. */
  async function searchIssuesAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorActionResult> {
    const scope = requireScope(input.config);
    const { query, state, assignee, updatedWithinDays, after } = parseSearchIssuesRequest(
      input.request,
    );
    const filterParts: Array<Record<string, unknown>> = [issueScopeFilter(scope)];
    if (state !== undefined) {
      filterParts.push({ state: { name: { eqIgnoreCase: state } } });
    }
    if (assignee !== undefined) {
      filterParts.push(
        assignee.toLowerCase() === "me"
          ? { assignee: { isMe: { eq: true } } }
          : { assignee: { name: { containsIgnoreCase: assignee } } },
      );
    }
    if (updatedWithinDays !== undefined) {
      const since = new Date(Date.now() - updatedWithinDays * MS_PER_DAY).toISOString();
      filterParts.push({ updatedAt: { gte: since } });
    }
    const data = await client.query<
      | {
          searchIssues?: {
            nodes?: unknown;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          };
        }
      | undefined
    >(input.accessToken, SEARCH_ISSUES_QUERY, {
      term: query,
      after,
      filter: { and: filterParts },
    });
    const connection = requireConnection<RawIssueNode>(data?.searchIssues);
    const issues: LinearIssueSummary[] = [];
    for (const node of connection.nodes) {
      if (!issueInScope(node, scope)) continue;
      issues.push(toIssueSummary(node));
    }
    const nextCursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor ?? null
      : null;
    return { result: { issues, nextCursor } };
  }

  /** `read_linear_issue`: one issue by identifier or UUID, with description,
   * labels and the 20 most recent comments. A null issue, a not-found from the
   * client, or an issue outside the selection all collapse to the same
   * not-found. */
  async function readIssueAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorActionResult> {
    const scope = requireScope(input.config);
    const { id } = parseReadIssueRequest(input.request);
    let data: { issue?: RawIssueDetail | null } | undefined;
    try {
      data = await client.query<{ issue?: RawIssueDetail | null } | undefined>(
        input.accessToken,
        ISSUE_QUERY,
        { id },
      );
    } catch (error) {
      // The id was already pattern-validated, so not-found is the only
      // provider-side error expected here. An unrecognised GraphQL error
      // (LINEAR_REQUEST_FAILED) is folded into the same not-found so a missing
      // issue cannot answer differently from an out-of-scope one. Rate limits,
      // unavailability and reauthorization still propagate.
      if (
        error instanceof LinearAdapterError &&
        (error.code === "LINEAR_NOT_FOUND" || error.code === "LINEAR_REQUEST_FAILED")
      ) {
        throw issueNotFound();
      }
      throw error;
    }
    if (!data) throw requestFailed();
    const issue = data.issue;
    if (!issue || !issueInScope(issue, scope)) throw issueNotFound();

    const description = cutText(typeof issue.description === "string" ? issue.description : "");
    const labels = Array.isArray(issue.labels?.nodes)
      ? issue.labels.nodes
          .map((label) => label?.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    const commentNodes = Array.isArray(issue.comments?.nodes) ? issue.comments.nodes : [];
    // Linear returns at most 20 comments in an unspecified order; sort them
    // oldest-first so the agent reads the thread in sequence.
    const comments = [...commentNodes]
      .sort(
        (a, b) =>
          new Date(a?.createdAt ?? 0).getTime() - new Date(b?.createdAt ?? 0).getTime(),
      )
      .map((comment) => ({
        author: comment?.user?.name ?? null,
        createdAt: comment?.createdAt,
        body: cutText(typeof comment?.body === "string" ? comment.body : "").value,
      }));
    const commentsTruncated = issue.comments?.pageInfo?.hasNextPage === true;

    return {
      externalId: issue.id,
      result: {
        ...toIssueSummary(issue),
        description: description.value,
        descriptionTruncated: description.truncated,
        labels,
        createdAt: issue.createdAt,
        comments,
        commentsTruncated,
        commentsNote: commentsTruncated ? COMMENTS_TRUNCATED_NOTE : null,
      },
    };
  }

  /** `list_linear_projects`: the projects inside the selection. The scope
   * filter is sent to Linear and re-applied to every returned node. */
  async function listProjectsAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorActionResult> {
    const scope = requireScope(input.config);
    const data = await client.query<
      { projects?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean } } } | undefined
    >(input.accessToken, PROJECTS_QUERY, {
      first: PROJECTS_LIST_LIMIT,
      filter: projectScopeFilter(scope),
    });
    const connection = requireConnection<RawProjectNode>(data?.projects);
    const projects: LinearProjectSummary[] = [];
    for (const node of connection.nodes) {
      if (!projectInScope(node, scope)) continue;
      projects.push(toProjectSummary(node));
    }
    return { result: { projects, truncated: connection.pageInfo.hasNextPage === true } };
  }

  return {
    capabilityId: "sourceweft/linear",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Linear for a code it cannot exchange.
      return toBackendLinearManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(input: OAuthCodeExchangeInput): Promise<OAuthTokenSet> {
      requireConfiguredClient();
      const token = await client.exchangeAuthorizationCode(input.code, input.redirectUri);
      const identity = await client.query<{
        viewer: { id: string; email: string };
        organization: { id: string; name: string };
      }>(token.accessToken, IDENTITY_QUERY, {});
      return {
        ...token,
        providerAccountId: `${identity.organization.id}:${identity.viewer.id}`,
        providerAccountEmail: identity.viewer.email,
        displayName: identity.organization.name,
      };
    },
    async refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      requireConfiguredClient();
      return client.refreshAccessToken(input.refreshToken);
    },
    // Tools-only connector: nothing is ever discovered or indexed. The
    // selection chosen in the dialog only scopes the agent tools.
    // `discoverPages` is intentionally not defined.
    async *discover(_input: ConnectorDiscoverInput): AsyncIterable<ConnectorItem> {
      // Yields nothing.
    },
    async extract(_input: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      throw new LinearAdapterError(
        400,
        "LINEAR_UNSUPPORTED_ACTION",
        "Linear does not support extraction",
      );
    },
    async executeAction(input: ConnectorActionInput): Promise<ConnectorActionResult> {
      if (input.actionType === "linear.browse") {
        return { result: await browseAction(input) };
      }
      if (input.actionType === "linear.search") {
        return { result: await searchAction(input) };
      }
      if (input.actionType === "linear.describe") {
        return { result: await describeAction(input) };
      }
      if (input.actionType === "linear.issue.search") {
        return searchIssuesAction(input);
      }
      if (input.actionType === "linear.issue.read") {
        return readIssueAction(input);
      }
      if (input.actionType === "linear.project.list") {
        return listProjectsAction(input);
      }
      throw new LinearAdapterError(400, "LINEAR_UNSUPPORTED_ACTION", "Unsupported Linear action");
    },
  };
}
