import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { GITHUB_INSTALLATION_CONTAINER_PATTERN, GITHUB_NODE_ID_PATTERN } from "./contribution";
import { GithubAdapterError } from "./errors";
import type { GithubApi, GithubInstallation, GithubInstallationRepository } from "./github-client";

/*
 * Browse-dialog action contract (ruling R1): `github.browse`, `github.search`
 * and `github.describe` return the generic selection-contract result types
 * (`ConnectorSelectionBrowseResult`, `ConnectorSelectionSearchResult`,
 * `ConnectorSelectionDescribeResult`) defined and validated in
 * `packages/contracts/src/connectors.ts`.
 *
 * `github.browse` request `{ containerId?: "installation:<id>" | null, cursor?: string }`.
 * Without `containerId` or `cursor` it lists the first page of GitHub App
 * installations the user has. With `containerId` it lists the first page of
 * repositories that installation grants access to; the installation must
 * appear in `listInstallations` (never trusted from the id alone) or the
 * request 404s. A `cursor` continues either listing: `r:<page>` for the
 * installation list, `i:<installationId>:<page>` for one installation's
 * repositories. `containerId` together with `cursor`, or a cursor of another
 * shape, is rejected. Every result carries a `helpLink` pointing at the
 * GitHub App's installation page (ruling R9/contribution `add_repositories`).
 *
 * `github.search` (R5): a single shot across installed repositories, at most
 * 10 pages of 100, matching `full_name` case-insensitively against the
 * query, returning the first 50 matches with `cursor: ""`, `hasMore: false`.
 * A request `cursor` is rejected.
 *
 * `github.describe` request `{ ids: string[] }` with 1-100 repository node
 * ids. Items come back in request order; an id that does not resolve has
 * `exists: false` and every other field but `id` is null.
 */

const CONTAINER_ID_REGEX = new RegExp(GITHUB_INSTALLATION_CONTAINER_PATTERN);
const NODE_ID_REGEX = new RegExp(GITHUB_NODE_ID_PATTERN);
const ROOT_CURSOR_REGEX = /^r:([1-9][0-9]*)$/;
const INSTALLATION_CURSOR_REGEX = /^i:([1-9][0-9]{0,19}):([1-9][0-9]*)$/;

const DESCRIBE_MAX_IDS = 100;
const SEARCH_MAX_REPOSITORY_PAGES = 10;
const SEARCH_MAX_RESULTS = 50;
const CURSOR_MAX_LENGTH = 4096;
const HELP_LINK_CODE = "add_repositories";
/** Cap on `findInstallation`'s own walk of `listInstallations` pages. A
 * `containerId` comes from the manifest-validated pattern, but a browse
 * `cursor`'s installation id is caller-supplied text (`i:<id>:<page>`) that
 * reaches this check too, so the walk itself must be bounded regardless of
 * how many pages `listInstallations` claims to have. */
const FIND_INSTALLATION_MAX_PAGES = 10;

function invalidRequest(): never {
  throw new GithubAdapterError(400, "GITHUB_INVALID_REQUEST", "Invalid GitHub request");
}

function helpLinkFor(appSlug: string): { code: string; url: string } {
  return {
    code: HELP_LINK_CODE,
    url: `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
  };
}

type BrowseCursor =
  | { kind: "root"; page: number }
  | { kind: "installation"; installationId: number; page: number };

function parseBrowseCursor(cursor: string): BrowseCursor {
  const rootMatch = ROOT_CURSOR_REGEX.exec(cursor);
  if (rootMatch) {
    return { kind: "root", page: Number(rootMatch[1]) };
  }
  const installationMatch = INSTALLATION_CURSOR_REGEX.exec(cursor);
  if (installationMatch) {
    return {
      kind: "installation",
      installationId: Number(installationMatch[1]),
      page: Number(installationMatch[2]),
    };
  }
  invalidRequest();
}

function encodeRootCursor(page: number): string {
  return `r:${page}`;
}

function encodeInstallationCursor(installationId: number, page: number): string {
  return `i:${installationId}:${page}`;
}

type ParsedBrowseRequest = { containerId: string | null; cursor?: string };

function parseBrowseRequest(request: Record<string, unknown>): ParsedBrowseRequest {
  const rawContainerId = request.containerId;
  const rawCursor = request.cursor;

  const hasContainerId = rawContainerId !== undefined && rawContainerId !== null;
  const hasCursor = rawCursor !== undefined;
  if (hasContainerId && hasCursor) {
    invalidRequest();
  }

  let containerId: string | null = null;
  if (hasContainerId) {
    if (typeof rawContainerId !== "string" || !CONTAINER_ID_REGEX.test(rawContainerId)) {
      invalidRequest();
    }
    containerId = rawContainerId;
  }

  let cursor: string | undefined;
  if (hasCursor) {
    if (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH) {
      invalidRequest();
    }
    cursor = rawCursor;
  }

  return { containerId, cursor };
}

function parseInstallationContainerId(containerId: string): number {
  return Number(containerId.slice("installation:".length));
}

function sortByNameCaseInsensitive<T extends { name: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function toInstallationEntry(installation: GithubInstallation): ConnectorSelectionEntry {
  return {
    id: `installation:${installation.id}`,
    kind: "account",
    name: installation.login,
    detail: installation.type,
    selectable: false,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

function toRepositoryEntry(repository: GithubInstallationRepository): ConnectorSelectionEntry {
  return {
    id: repository.nodeId,
    kind: "repository",
    name: repository.name,
    detail: repository.fullName,
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: null,
    modifiedAt: repository.updatedAt,
  };
}

/** Finds the installation with `installationId` by walking `listInstallations`
 * pages; the id is never trusted on its own (the brief: "never trust the
 * id"), so a container that is not actually one of the user's installations
 * 404s instead of silently listing nothing. Bounded at
 * `FIND_INSTALLATION_MAX_PAGES` pages — the id checked here can come from a
 * caller-supplied cursor, not only the manifest-validated `containerId`
 * pattern, so the walk must not be driven solely by `listInstallations`'
 * own `hasMore`. */
async function findInstallation(
  api: GithubApi,
  installationId: number,
): Promise<GithubInstallation | null> {
  let page = 1;
  while (page <= FIND_INSTALLATION_MAX_PAGES) {
    const { installations, hasMore } = await api.listInstallations(page);
    const found = installations.find((installation) => installation.id === installationId);
    if (found) return found;
    if (!hasMore) return null;
    page += 1;
  }
  return null;
}

export async function browseAction(
  api: GithubApi,
  appSlug: string,
  request: Record<string, unknown>,
): Promise<ConnectorSelectionBrowseResult> {
  const helpLink = helpLinkFor(appSlug);
  const { containerId, cursor } = parseBrowseRequest(request);

  if (cursor !== undefined) {
    const parsedCursor = parseBrowseCursor(cursor);
    if (parsedCursor.kind === "root") {
      const { installations, hasMore } = await api.listInstallations(parsedCursor.page);
      return {
        container: null,
        breadcrumbs: [],
        entries: sortByNameCaseInsensitive(installations.map(toInstallationEntry)),
        cursor: hasMore ? encodeRootCursor(parsedCursor.page + 1) : "",
        hasMore,
        helpLink,
      };
    }
    const cursorInstallation = await findInstallation(api, parsedCursor.installationId);
    if (!cursorInstallation) {
      throw new GithubAdapterError(404, "GITHUB_NOT_FOUND", "GitHub installation not found");
    }
    const { repositories, hasMore } = await api.listInstallationRepositories(
      parsedCursor.installationId,
      parsedCursor.page,
    );
    return {
      container: null,
      breadcrumbs: [],
      entries: sortByNameCaseInsensitive(repositories.map(toRepositoryEntry)),
      cursor: hasMore
        ? encodeInstallationCursor(parsedCursor.installationId, parsedCursor.page + 1)
        : "",
      hasMore,
      helpLink,
    };
  }

  if (containerId === null) {
    const { installations, hasMore } = await api.listInstallations(1);
    return {
      container: null,
      breadcrumbs: [],
      entries: sortByNameCaseInsensitive(installations.map(toInstallationEntry)),
      cursor: hasMore ? encodeRootCursor(2) : "",
      hasMore,
      helpLink,
    };
  }

  const installationId = parseInstallationContainerId(containerId);
  const installation = await findInstallation(api, installationId);
  if (!installation) {
    throw new GithubAdapterError(404, "GITHUB_NOT_FOUND", "GitHub installation not found");
  }
  const { repositories, hasMore } = await api.listInstallationRepositories(installationId, 1);
  return {
    container: { id: containerId, kind: "account", name: installation.login, detail: null },
    breadcrumbs: [],
    entries: sortByNameCaseInsensitive(repositories.map(toRepositoryEntry)),
    cursor: hasMore ? encodeInstallationCursor(installationId, 2) : "",
    hasMore,
    helpLink,
  };
}

function parseSearchRequest(request: Record<string, unknown>): { query: string } {
  if ("cursor" in request && request.cursor !== undefined) {
    invalidRequest();
  }
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") {
    invalidRequest();
  }
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > 200) {
    invalidRequest();
  }
  return { query };
}

/** R5: walks installed repositories (across every installation, in
 * installation-page order), at most 10 total repository-list page requests,
 * and returns the first 50 whose `full_name` contains the query
 * case-insensitively. Always a single shot: `cursor: ""`, `hasMore: false`. */
export async function searchAction(
  api: GithubApi,
  request: Record<string, unknown>,
): Promise<ConnectorSelectionSearchResult> {
  const { query } = parseSearchRequest(request);
  const needle = query.toLowerCase();
  const matches: GithubInstallationRepository[] = [];
  let repositoryPagesFetched = 0;
  let installationPage = 1;

  outer: while (true) {
    const { installations, hasMore: moreInstallations } = await api.listInstallations(
      installationPage,
    );
    for (const installation of installations) {
      let repositoryPage = 1;
      while (repositoryPagesFetched < SEARCH_MAX_REPOSITORY_PAGES) {
        const { repositories, hasMore: moreRepositories } = await api.listInstallationRepositories(
          installation.id,
          repositoryPage,
        );
        repositoryPagesFetched += 1;
        for (const repository of repositories) {
          if (repository.fullName.toLowerCase().includes(needle)) {
            matches.push(repository);
            if (matches.length >= SEARCH_MAX_RESULTS) break outer;
          }
        }
        if (!moreRepositories) break;
        repositoryPage += 1;
      }
      if (repositoryPagesFetched >= SEARCH_MAX_REPOSITORY_PAGES) break outer;
    }
    if (!moreInstallations) break;
    installationPage += 1;
  }

  return {
    entries: matches.map(toRepositoryEntry),
    cursor: "",
    hasMore: false,
  };
}

function parseDescribeRequest(request: Record<string, unknown>): { ids: string[] } {
  const rawIds = request.ids;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > DESCRIBE_MAX_IDS) {
    invalidRequest();
  }
  const ids: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== "string" || !NODE_ID_REGEX.test(id)) {
      invalidRequest();
    }
    ids.push(id);
  }
  return { ids };
}

export async function describeAction(
  api: GithubApi,
  request: Record<string, unknown>,
): Promise<ConnectorSelectionDescribeResult> {
  const { ids } = parseDescribeRequest(request);
  const resolved = await api.resolveRepositories(ids);
  const items: ConnectorSelectionDescribeItem[] = ids.map((id, index) => {
    const repository = resolved[index] ?? null;
    if (!repository) {
      return { id, kind: null, name: null, detail: null, exists: false, meta: {} };
    }
    return {
      id,
      kind: "repository",
      name: repository.name,
      detail: repository.nameWithOwner,
      exists: true,
      meta: {},
    };
  });
  return { items };
}
