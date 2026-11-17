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
  PROJECTS_QUERY,
  TEAMS_QUERY,
  TEAM_PROJECTS_QUERY,
} from "./documents";
import { LinearAdapterError, createLinearClient } from "./linear-client";

export { LinearAdapterError } from "./linear-client";

/** `linear.search`'s own cap on how many teams/projects it returns, each
 * (R5: at most 25 matching teams followed by at most 25 matching projects, no
 * paging). `TEAMS_QUERY` has no `first` variable (it is fixed at 50 in the
 * document), so the team half of this cap is applied by slicing the result;
 * `PROJECTS_QUERY` takes `first` as a variable and is called with it
 * directly. */
const SEARCH_RESULT_LIMIT = 25;
/** `linear.describe`'s own cap on how many ids one call may request (matches
 * the contribution's `linear.describe` input schema and the selection
 * contract's `items`/`DescribeResult` bound). */
const DESCRIBE_MAX_IDS = 100;
/** A request cursor is opaque to this adapter; only its size is bounded
 * (matches the `cursor` field's `maxLength` in contribution.ts). */
const CURSOR_MAX_LENGTH = 4096;
/** `linear.search`'s own bound on the query string, after trimming (matches
 * the contribution's `linear.search` input schema). */
const SEARCH_QUERY_MAX_LENGTH = 200;
const SELECTION_ITEM_ID = new RegExp(LINEAR_ITEM_ID_PATTERN);

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
 * needing `containerId` again (R6): it is opaque, base64url of `{"t": <team
 * id or null>, "a": <Linear endCursor>}`. A continuation page always reports
 * `container: null`; a team sits directly under the root, so `breadcrumbs` is
 * always `[]` and `helpLink` is always `null`. Entries are sorted by name
 * (case-insensitive) within a page.
 *
 * `linear.search` request `{ query: string (1-200 chars after trimming) }`.
 * Matches team and project names. No paging (R5): `cursor` is always `""`,
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

/** R6: opaque to callers; base64url of `{"t": <teamId or null>, "a": <Linear
 * endCursor>}`. */
function encodeBrowseCursor(teamId: string | null, after: string): string {
  return Buffer.from(JSON.stringify({ t: teamId, a: after }), "utf8").toString("base64url");
}

/** Throws `400 LINEAR_INVALID_REQUEST` when `cursor` does not decode to the
 * `{t, a}` shape R6 defines. */
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
  return { teamId: t, after: a };
}

/** The query is validated against its 1-200 char bound only after trimming,
 * and a request that itself carries a `cursor` is rejected outright (R5:
 * `linear.search` never paginates). */
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
   * continues either listing via an opaque cursor (R6). The request is
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
   * (at most 25) then projects (at most 25), never paginated (R5). */
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
        PROJECTS_QUERY,
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

  /** `linear.describe`: looks up every requested id as a team or a project,
   * in parallel, and reports each in request order. An id matching neither
   * comes back `exists: false` with every other field `null`. */
  async function describeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionDescribeResult> {
    const { ids } = parseDescribeRequest(input.request);
    const idFilter = { id: { in: ids } };
    const [teamsData, projectsData] = await Promise.all([
      client.query<{ teams: { nodes: LinearTeamNode[] } }>(input.accessToken, TEAMS_QUERY, {
        after: undefined,
        filter: idFilter,
      }),
      client.query<{ projects: { nodes: LinearProjectNode[] } }>(
        input.accessToken,
        PROJECTS_QUERY,
        { first: DESCRIBE_MAX_IDS, filter: idFilter },
      ),
    ]);
    const teamsById = new Map(teamsData.teams.nodes.map((team) => [team.id, team]));
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
      const token = await client.exchangeAuthorizationCode(input.code, input.redirectUri);
      const identity = await client.query<{
        viewer: { id: string; name: string; email: string };
        organization: { id: string; name: string; urlKey: string };
      }>(token.accessToken, IDENTITY_QUERY, {});
      return {
        ...token,
        providerAccountId: `${identity.organization.id}:${identity.viewer.id}`,
        providerAccountEmail: identity.viewer.email,
        displayName: identity.organization.name,
      };
    },
    refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      return client.refreshAccessToken(input.refreshToken);
    },
    // Tools-only connector: nothing is ever discovered or indexed. The
    // selection chosen in the dialog only scopes the agent tools (Task 4).
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
      throw new LinearAdapterError(400, "LINEAR_UNSUPPORTED_ACTION", "Unsupported Linear action");
    },
  };
}
