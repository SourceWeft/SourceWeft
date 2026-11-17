import {
  AtlassianApiError,
  exchangeAtlassianCode,
  getMe,
  listAccessibleResources,
  refreshAtlassianToken,
  type AtlassianClientConfig,
  type AtlassianSite,
} from "@sourceweft/atlassian-client";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendJiraManifest } from "./backend-manifest";
import { parseProjectId, parseSiteId, projectItemId, siteItemId } from "./ids";
import { createJiraClient, type JiraProject } from "./jira-client";
import { executeJiraLiveTool } from "./live-tools";

export type JiraAdapterConfig = {
  baseUrl: string;
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

/** Selection fan-out cap (Global Constraints: at most 5 sites per call,
 * sites sorted by cloud id — `listAccessibleResources` already returns them
 * in that order). */
const MAX_FANOUT_SITES = 5;
/** `jira.search` (R4): one bounded page, at most 20 matches per site. */
const SEARCH_PAGE_SIZE = 20;
/** `jira.browse` page size for the projects within a site. */
const BROWSE_PAGE_SIZE = 50;
/** Matches the `cursor` field's `maxLength` declared in contribution.ts. */
const CURSOR_MAX_LENGTH = 4096;
/** The OAuth scope that marks a site as a Jira site this connector may read
 * (R3: a site is included only if its scopes contain this). */
const JIRA_READ_SCOPE = "read:jira-work";

function unsupported(): AtlassianApiError {
  return new AtlassianApiError(400, "JIRA_UNSUPPORTED", "Not yet implemented");
}

function unsupportedAction(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "JIRA_UNSUPPORTED_ACTION",
    "Unsupported Jira action",
  );
}

function invalidRequest(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "JIRA_INVALID_REQUEST",
    "Invalid Jira request",
  );
}

function siteNotFound(): AtlassianApiError {
  return new AtlassianApiError(404, "JIRA_NOT_FOUND", "Jira site not found");
}

function unconfigured(): AtlassianApiError {
  return new AtlassianApiError(503, "JIRA_UNAVAILABLE", "Jira is not configured");
}

function hasJiraScope(site: AtlassianSite): boolean {
  return site.scopes.includes(JIRA_READ_SCOPE);
}

/** The site's host (e.g. `example.atlassian.net`) for a selection entry's
 * `detail`. An unparseable `url` (never expected from a real site, but the
 * provider payload is not trusted) falls back to an empty string rather than
 * throwing. */
function siteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

type JiraBrowseCursor = { v: 1; containerId: string; startAt: number };

/** `jira.browse` pagination cursor: `base64url(JSON.stringify({ v, containerId, startAt }))`. */
function encodeBrowseCursor(data: JiraBrowseCursor): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

/** Decodes and validates a `jira.browse` cursor. Any mismatch (bad base64url,
 * bad JSON, wrong version, a `containerId` that is not a well-formed site id,
 * or a non-integer `startAt`) is `400 JIRA_INVALID_REQUEST` — this check runs
 * before any request reaches Jira. */
function decodeBrowseCursor(value: string): JiraBrowseCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.v !== 1 ||
      typeof parsed.containerId !== "string" ||
      parseSiteId(parsed.containerId) === null ||
      typeof parsed.startAt !== "number" ||
      !Number.isInteger(parsed.startAt) ||
      parsed.startAt < 0
    ) {
      throw new Error("malformed Jira browse cursor");
    }
    return parsed as JiraBrowseCursor;
  } catch {
    throw invalidRequest();
  }
}

function parseBrowseRequest(
  request: Record<string, unknown>,
): { containerId: string | null; cursor?: string } {
  const rawCursor = request.cursor;
  if (
    rawCursor !== undefined &&
    (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH)
  ) {
    throw invalidRequest();
  }
  const rawContainerId = request.containerId;
  let containerId: string | null = null;
  if (rawContainerId !== undefined && rawContainerId !== null) {
    if (
      typeof rawContainerId !== "string" ||
      parseSiteId(rawContainerId) === null
    ) {
      throw invalidRequest();
    }
    containerId = rawContainerId;
  }
  return { containerId, cursor: rawCursor ? rawCursor : undefined };
}

/** Validates `jira.search`'s request. The query is trimmed and bounded to
 * 1-200 chars; `jira.search` is one bounded page (R4), so an empty cursor is
 * accepted (and ignored) while a non-empty one is rejected before any
 * request reaches Jira — this is the Task 4 finding I1 rule. */
function parseSearchRequest(
  request: Record<string, unknown>,
): { query: string } {
  const rawCursor = request.cursor;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH) {
      throw invalidRequest();
    }
    if (rawCursor !== "") throw invalidRequest();
  }
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") throw invalidRequest();
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > 200) throw invalidRequest();
  return { query };
}

type ParsedDescribeId = { id: string; cloudId: string; projectId: string };

function parseDescribeRequest(
  request: Record<string, unknown>,
): { ids: ParsedDescribeId[] } {
  const rawIds = request.ids;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 100) {
    throw invalidRequest();
  }
  const ids: ParsedDescribeId[] = [];
  for (const rawId of rawIds) {
    if (typeof rawId !== "string") throw invalidRequest();
    const parsed = parseProjectId(rawId);
    if (!parsed) throw invalidRequest();
    ids.push({ id: rawId, cloudId: parsed.cloudId, projectId: parsed.projectId });
  }
  return { ids };
}

function toSiteEntry(site: AtlassianSite): ConnectorSelectionEntry {
  return {
    id: siteItemId(site.cloudId),
    kind: "site",
    name: site.name,
    detail: siteHost(site.url),
    selectable: false,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

function toProjectEntry(
  cloudId: string,
  project: JiraProject,
): ConnectorSelectionEntry {
  return {
    id: projectItemId(cloudId, project.id),
    kind: "project",
    name: project.name,
    detail: project.key,
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

/**
 * Jira connector adapter: OAuth and the selection actions (Task 6) plus the
 * three agent-visible live tools (Task 7, in `live-tools.ts`). This is a
 * tools-only connector, so `discover` stays empty and `extract` stays
 * unsupported.
 */
export function createJiraConnectorAdapter(
  config: JiraAdapterConfig,
): ConnectorAdapter {
  const redirectUri =
    config.redirectUri ?? `${config.baseUrl}/v1/connectors/oauth/jira/callback`;
  const atlassianConfig: AtlassianClientConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    errorPrefix: "JIRA",
    fetcher: config.fetcher,
  };
  const client = createJiraClient(atlassianConfig);

  /**
   * `jira.browse`: root lists Jira sites (R3); a first page for a
   * `site:<cloudId>` container lists that site's projects; a page fetched
   * with `cursor` continues that listing without re-resolving the
   * container or breadcrumbs.
   */
  async function browseAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionBrowseResult> {
    const { containerId, cursor } = parseBrowseRequest(input.request);

    if (cursor) {
      const decoded = decodeBrowseCursor(cursor);
      const cloudId = parseSiteId(decoded.containerId)!;
      const page = await client.listProjects(input.accessToken, cloudId, {
        startAt: decoded.startAt,
        maxResults: BROWSE_PAGE_SIZE,
      });
      return {
        container: null,
        breadcrumbs: [],
        entries: page.projects.map((project) => toProjectEntry(cloudId, project)),
        cursor: page.isLast
          ? ""
          : encodeBrowseCursor({
              v: 1,
              containerId: decoded.containerId,
              startAt: page.nextStartAt,
            }),
        hasMore: !page.isLast,
        helpLink: null,
      };
    }

    const sites = await listAccessibleResources(atlassianConfig, input.accessToken);

    if (containerId === null) {
      const entries = sites
        .filter(hasJiraScope)
        .map(toSiteEntry)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        container: null,
        breadcrumbs: [],
        entries,
        cursor: "",
        hasMore: false,
        helpLink: null,
      };
    }

    const cloudId = parseSiteId(containerId)!;
    const site = sites.find(
      (candidate) => candidate.cloudId === cloudId && hasJiraScope(candidate),
    );
    if (!site) throw siteNotFound();

    const page = await client.listProjects(input.accessToken, cloudId, {
      startAt: 0,
      maxResults: BROWSE_PAGE_SIZE,
    });
    return {
      container: {
        id: siteItemId(cloudId),
        kind: "site",
        name: site.name,
        detail: siteHost(site.url),
      },
      breadcrumbs: [],
      entries: page.projects.map((project) => toProjectEntry(cloudId, project)),
      cursor: page.isLast
        ? ""
        : encodeBrowseCursor({ v: 1, containerId, startAt: page.nextStartAt }),
      hasMore: !page.isLast,
      helpLink: null,
    };
  }

  /** `jira.search` (R4): the first {@link MAX_FANOUT_SITES} sites with the
   * Jira read scope, up to {@link SEARCH_PAGE_SIZE} matches each, one bounded
   * page (`hasMore: false`, `cursor: ""`). */
  async function searchAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionSearchResult> {
    const { query } = parseSearchRequest(input.request);
    const sites = await listAccessibleResources(atlassianConfig, input.accessToken);
    const candidates = sites.filter(hasJiraScope).slice(0, MAX_FANOUT_SITES);

    const entries: ConnectorSelectionEntry[] = [];
    for (const site of candidates) {
      const page = await client.listProjects(input.accessToken, site.cloudId, {
        query,
        maxResults: SEARCH_PAGE_SIZE,
      });
      for (const project of page.projects) {
        entries.push({
          id: projectItemId(site.cloudId, project.id),
          kind: "project",
          name: project.name,
          detail: `${project.key} · ${site.name}`,
          selectable: true,
          expandable: false,
          disabledReason: null,
          size: null,
          modifiedAt: null,
        });
      }
    }
    return { entries, cursor: "", hasMore: false };
  }

  /** `jira.describe`: ids grouped by site, resolved with
   * `getProjectsByIds`, in request order. A site that no longer resolves
   * (`JIRA_NOT_FOUND`) marks every one of its ids as missing rather than
   * failing the whole request. */
  async function describeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionDescribeResult> {
    const { ids } = parseDescribeRequest(input.request);
    const sites = await listAccessibleResources(atlassianConfig, input.accessToken);
    const siteByCloudId = new Map(sites.map((site) => [site.cloudId, site]));

    const projectIdsByCloudId = new Map<string, string[]>();
    for (const { cloudId, projectId } of ids) {
      const existing = projectIdsByCloudId.get(cloudId);
      if (existing) existing.push(projectId);
      else projectIdsByCloudId.set(cloudId, [projectId]);
    }

    const projectByItemId = new Map<string, JiraProject>();
    for (const [cloudId, projectIds] of projectIdsByCloudId) {
      const site = siteByCloudId.get(cloudId);
      if (!site || !hasJiraScope(site)) {
        // The site is not in accessible resources, or has lost the Jira read
        // scope: every id under it is missing and no request is made for it.
        continue;
      }
      let projects: JiraProject[];
      try {
        projects = await client.getProjectsByIds(
          input.accessToken,
          cloudId,
          projectIds,
        );
      } catch (error) {
        if (error instanceof AtlassianApiError && error.code === "JIRA_NOT_FOUND") {
          // The site stopped resolving mid-request: every id under it is missing.
          projects = [];
        } else {
          throw error;
        }
      }
      for (const project of projects) {
        projectByItemId.set(projectItemId(cloudId, project.id), project);
      }
    }

    const items: ConnectorSelectionDescribeItem[] = ids.map(({ id, cloudId }) => {
      const project = projectByItemId.get(id);
      if (!project) {
        const missing: ConnectorSelectionDescribeItem = {
          id,
          kind: null,
          name: null,
          detail: null,
          exists: false,
          meta: {},
        };
        return missing;
      }
      const site = siteByCloudId.get(cloudId);
      return {
        id,
        kind: "project",
        name: project.name,
        detail: project.key,
        exists: true,
        meta: { key: project.key, siteUrl: site?.url ?? "" },
      };
    });
    return { items };
  }

  return {
    capabilityId: "sourceweft/jira",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Atlassian for a code it cannot exchange.
      return toBackendJiraManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      // Without both credentials no token request can succeed, so fail before
      // sending a code that cannot be exchanged.
      if (!config.clientId || !config.clientSecret) throw unconfigured();
      const token = await exchangeAtlassianCode(atlassianConfig, {
        code: input.code,
        redirectUri: input.redirectUri,
      });
      const identity = await getMe(atlassianConfig, token.accessToken);
      return {
        ...token,
        providerAccountId: identity.accountId,
        providerAccountEmail: identity.email,
        displayName: identity.name ?? identity.email ?? identity.accountId,
      };
    },
    async refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      if (!config.clientId || !config.clientSecret) throw unconfigured();
      return refreshAtlassianToken(atlassianConfig, input.refreshToken);
    },
    async *discover(
      _input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      // Tools-only connector (Global Constraints): nothing is indexed.
    },
    async extract(
      _input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      throw unsupported();
    },
    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === "jira.browse") {
        return { result: await browseAction(input) };
      }
      if (input.actionType === "jira.search") {
        return { result: await searchAction(input) };
      }
      if (input.actionType === "jira.describe") {
        return { result: await describeAction(input) };
      }
      // The three agent-visible live tools (`jira.issue.search`,
      // `jira.issue.read`, `jira.project.list`): `null` means not one of them.
      const liveResult = await executeJiraLiveTool(
        { client, atlassianConfig },
        input,
      );
      if (liveResult) return liveResult;
      throw unsupportedAction();
    },
  };
}
