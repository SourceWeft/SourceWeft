import { Octokit } from "@octokit/core";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { OAuthTokenSet } from "@sourceweft/contracts";
import { GithubAdapterError } from "./errors";

/**
 * GitHub API client for the connector: OAuth token exchange/refresh over plain
 * `fetch`, and REST/GraphQL calls through `@octokit/core` with the retry,
 * throttling and pagination plugins. Every provider failure is mapped onto a
 * `GithubAdapterError` whose message never carries a token, a header, the
 * query text or a response body (constraints A4, spec §error handling).
 *
 * Tests inject a fake `fetch` through `fetcher` and pass `retryBaseMs: 0` so
 * neither a retry nor a throttle back-off waits in real time.
 */

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const REQUEST_TIMEOUT_MS = 30_000;
/** Token exchange/refresh is a short, user-blocking round trip, so it is held
 * to a tighter deadline than ordinary API calls. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** Production multiplier (ms) for retry/throttle back-offs; tests pass 0. */
const DEFAULT_RETRY_BASE_MS = 1_000;
/** At most one retry, and only on 5xx (every mapped 4xx sits in `doNotRetry`). */
const MAX_RETRIES = 1;
/** The throttle plugin may retry once, and only for short waits. */
const THROTTLE_MAX_RETRY_AFTER_SECONDS = 10;
const PER_PAGE = 100;
/** Fallback wait advertised to the browser when a rate-limit response carries
 * no usable `retry-after`/`x-ratelimit-reset` header. */
const RATE_LIMIT_FALLBACK_SECONDS = 60;
/**
 * Statuses the retry plugin must never retry: every client error this file
 * maps explicitly, plus the other common GitHub 4xx. Rate limits (403/429) are
 * owned by the throttling plugin, so they are excluded here too. The result is
 * that only 5xx responses are retried.
 */
const DO_NOT_RETRY = [400, 401, 402, 403, 404, 405, 406, 409, 410, 422, 429, 451];

const GithubOctokit = Octokit.plugin(paginateRest, paginateGraphQL, retry, throttling);

/**
 * Isolates the throttling plugin's module-global Bottleneck groups per client
 * instance. The groups (`search` 2s, `write`/GraphQL 1s) space requests by a
 * throttle `id`; a shared id would make one instance's calls wait behind
 * another's. A distinct id per instance keeps GitHub's recommended spacing
 * within a single connection while letting separate connections — and every
 * test — run without blocking one another.
 */
let throttleInstanceSeq = 0;

export type GithubRepository = {
  id: string;
  nameWithOwner: string;
  name: string;
  url: string;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
};

export type GithubUser = { id: number; login: string; email: string | null };

export type GithubInstallation = { id: number; login: string; type: string };

export type GithubInstallationRepository = {
  nodeId: string;
  name: string;
  fullName: string;
  updatedAt: string | null;
};

/** Fields Task 5 needs for an issue or pull request, mapped defensively. */
export type GithubIssue = {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  authorLogin: string | null;
  labels: string[];
  assignees: string[];
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  body: string | null;
  isPullRequest: boolean;
};

/** A `GET /search/issues` row: an issue/PR plus its `repository_url` (R3). */
export type GithubIssueSearchItem = GithubIssue & { repositoryUrl: string | null };

export type GithubPull = GithubIssue & {
  merged: boolean;
  draft: boolean;
  baseRef: string | null;
  headRef: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
};

export type GithubComment = {
  authorLogin: string | null;
  body: string | null;
  createdAt: string | null;
  htmlUrl: string;
};

export type GithubDiscussionSearchItem = {
  repositoryId: string | null;
  repositoryNameWithOwner: string | null;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  labels: string[];
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  body: string | null;
};

export type GithubDiscussion = {
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  labels: string[];
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  body: string | null;
  comments: GithubComment[];
};

export type GithubApi = {
  getUser(): Promise<GithubUser>;
  listInstallations(
    page: number,
  ): Promise<{ installations: GithubInstallation[]; hasMore: boolean }>;
  listInstallationRepositories(
    installationId: number,
    page: number,
  ): Promise<{ repositories: GithubInstallationRepository[]; hasMore: boolean }>;
  resolveRepositories(ids: readonly string[]): Promise<Array<GithubRepository | null>>;
  searchIssues(
    q: string,
    perPage: number,
    page: number,
  ): Promise<{ items: GithubIssueSearchItem[]; totalCount: number }>;
  searchDiscussions(
    q: string,
    first: number,
    after: string | null,
  ): Promise<{ items: GithubDiscussionSearchItem[]; endCursor: string | null; hasNextPage: boolean }>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssue>;
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    perPage: number,
  ): Promise<GithubComment[]>;
  getPull(owner: string, repo: string, pullNumber: number): Promise<GithubPull>;
  getDiscussion(
    owner: string,
    repo: string,
    discussionNumber: number,
    commentCount: number,
  ): Promise<GithubDiscussion>;
};

export type GithubClientOptions = {
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  retryBaseMs?: number;
};

export type GithubClient = {
  exchangeAuthorizationCode(code: string, redirectUri: string): Promise<OAuthTokenSet>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet>;
  forToken(accessToken: string): GithubApi;
};

// --- small, defensive field helpers -----------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function actorLogin(actor: { login?: unknown } | null | undefined): string | null {
  return strOrNull(actor?.login);
}

type RestLabel = string | { name?: unknown } | null | undefined;

function restLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const label of labels as RestLabel[]) {
    if (typeof label === "string") {
      if (label) out.push(label);
    } else if (label && typeof label.name === "string" && label.name) {
      out.push(label.name);
    }
  }
  return out;
}

function graphqlLabels(labels: { nodes?: unknown } | null | undefined): string[] {
  const nodes = labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const node of nodes as Array<{ name?: unknown } | null>) {
    if (node && typeof node.name === "string" && node.name) out.push(node.name);
  }
  return out;
}

function restAssignees(assignees: unknown): string[] {
  if (!Array.isArray(assignees)) return [];
  const out: string[] = [];
  for (const assignee of assignees as Array<{ login?: unknown } | null>) {
    const login = actorLogin(assignee);
    if (login) out.push(login);
  }
  return out;
}

type RestIssueLike = {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  user?: { login?: unknown } | null;
  labels?: unknown;
  assignees?: unknown;
  comments?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  body?: unknown;
  pull_request?: unknown;
};

function mapIssueLike(item: RestIssueLike): GithubIssue {
  return {
    number: num(item.number),
    title: str(item.title),
    state: str(item.state),
    htmlUrl: str(item.html_url),
    authorLogin: actorLogin(item.user),
    labels: restLabels(item.labels),
    assignees: restAssignees(item.assignees),
    commentCount: num(item.comments),
    createdAt: strOrNull(item.created_at),
    updatedAt: strOrNull(item.updated_at),
    body: strOrNull(item.body),
    isPullRequest: item.pull_request != null,
  };
}

function mapSearchItem(item: RestIssueLike): GithubIssueSearchItem {
  return { ...mapIssueLike(item), repositoryUrl: strOrNull(item.repository_url) };
}

type RestPull = RestIssueLike & {
  merged?: unknown;
  draft?: unknown;
  base?: { ref?: unknown } | null;
  head?: { ref?: unknown } | null;
  changed_files?: unknown;
  additions?: unknown;
  deletions?: unknown;
};

function mapPull(data: RestPull): GithubPull {
  return {
    ...mapIssueLike(data),
    // A pull request object has no `pull_request` marker field of its own.
    isPullRequest: true,
    merged: data.merged === true,
    draft: data.draft === true,
    baseRef: strOrNull(data.base?.ref),
    headRef: strOrNull(data.head?.ref),
    changedFiles: num(data.changed_files),
    additions: num(data.additions),
    deletions: num(data.deletions),
  };
}

function mapComment(comment: {
  user?: { login?: unknown } | null;
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
}): GithubComment {
  return {
    authorLogin: actorLogin(comment.user),
    body: strOrNull(comment.body),
    createdAt: strOrNull(comment.created_at),
    htmlUrl: str(comment.html_url),
  };
}

type RepositoryNode = {
  id?: unknown;
  nameWithOwner?: unknown;
  name?: unknown;
  url?: unknown;
  description?: unknown;
  isPrivate?: unknown;
  isArchived?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
} | null;

function mapRepositoryNode(node: RepositoryNode | undefined): GithubRepository | null {
  if (!node || typeof node.id !== "string") return null;
  return {
    id: node.id,
    nameWithOwner: str(node.nameWithOwner),
    name: str(node.name),
    url: str(node.url),
    description: strOrNull(node.description),
    isPrivate: node.isPrivate === true,
    isArchived: node.isArchived === true,
    defaultBranch: strOrNull(node.defaultBranchRef?.name),
  };
}

type DiscussionNode = {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  body?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  author?: { login?: unknown } | null;
  repository?: { id?: unknown; nameWithOwner?: unknown } | null;
  comments?: { totalCount?: unknown; nodes?: unknown } | null;
  labels?: { nodes?: unknown } | null;
} | null;

function mapDiscussionSearchNode(node: DiscussionNode): GithubDiscussionSearchItem | null {
  if (!node || typeof node.number !== "number") return null;
  return {
    repositoryId: strOrNull(node.repository?.id),
    repositoryNameWithOwner: strOrNull(node.repository?.nameWithOwner),
    number: node.number,
    title: str(node.title),
    url: str(node.url),
    authorLogin: actorLogin(node.author),
    labels: graphqlLabels(node.labels),
    commentCount: num(node.comments?.totalCount),
    createdAt: strOrNull(node.createdAt),
    updatedAt: strOrNull(node.updatedAt),
    body: strOrNull(node.body),
  };
}

// --- error mapping ------------------------------------------------------------

/** Fixed, agent-facing failure messages. The platform forwards a connector
 * package's message to the agent, so these never carry a token, a header, the
 * query text, a response body or an `error_description`. */
const GITHUB_REAUTH_REQUIRED_MESSAGE =
  "GitHub no longer accepts this connection. Ask the user to reconnect GitHub in the connector settings.";
const GITHUB_NOT_FOUND_MESSAGE = "Not found on GitHub, or this connection cannot access it.";
const GITHUB_INVALID_REQUEST_MESSAGE =
  "GitHub rejected the request. Check the search text and parameters.";
const GITHUB_UNAVAILABLE_MESSAGE = "GitHub could not be reached. Try again shortly.";

function rateLimitedMessage(seconds: number): string {
  return `GitHub's rate limit was reached. Try again in ${seconds} seconds.`;
}

function reauthRequiredError(): GithubAdapterError {
  return new GithubAdapterError(400, "GITHUB_REAUTH_REQUIRED", GITHUB_REAUTH_REQUIRED_MESSAGE);
}

function oauthExchangeFailedError(): GithubAdapterError {
  return new GithubAdapterError(
    400,
    "GITHUB_OAUTH_EXCHANGE_FAILED",
    "GitHub authorization could not be completed",
  );
}

function unavailableError(): GithubAdapterError {
  return new GithubAdapterError(503, "GITHUB_UNAVAILABLE", GITHUB_UNAVAILABLE_MESSAGE);
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function rateLimitRetryAfter(headers: Record<string, unknown> | undefined): number {
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(Math.ceil(seconds), 0);
  }
  const reset = headerValue(headers, "x-ratelimit-reset");
  if (reset !== undefined && reset !== "") {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(Math.ceil((resetMs - Date.now()) / 1000), 0);
  }
  return RATE_LIMIT_FALLBACK_SECONDS;
}

/** Maps any Octokit failure (a `RequestError` with `.status`, or a network /
 * timeout error normalized by Octokit to status 500) onto the error the
 * platform reads. The message only ever states GitHub's own status. */
function mapOctokitError(error: unknown): GithubAdapterError {
  if (error instanceof GithubAdapterError) return error;
  const candidate = error as
    | { status?: unknown; response?: { headers?: Record<string, unknown> } }
    | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : 0;
  const headers = candidate?.response?.headers;

  if (status === 401) {
    return new GithubAdapterError(401, "GITHUB_REAUTH_REQUIRED", GITHUB_REAUTH_REQUIRED_MESSAGE);
  }

  const remaining = headerValue(headers, "x-ratelimit-remaining");
  const hasRetryAfter = headerValue(headers, "retry-after") !== undefined;
  if (status === 429 || (status === 403 && (remaining === "0" || hasRetryAfter))) {
    const seconds = rateLimitRetryAfter(headers);
    return new GithubAdapterError(429, "GITHUB_RATE_LIMITED", rateLimitedMessage(seconds), {
      retryAfterSeconds: seconds,
    });
  }
  if (status === 403 || status === 404 || status === 410) {
    return new GithubAdapterError(404, "GITHUB_NOT_FOUND", GITHUB_NOT_FOUND_MESSAGE);
  }
  if (status === 422) {
    return new GithubAdapterError(400, "GITHUB_INVALID_REQUEST", GITHUB_INVALID_REQUEST_MESSAGE);
  }
  if (status === 0 || status >= 500) return unavailableError();
  return new GithubAdapterError(status, "GITHUB_REQUEST_FAILED", `GitHub request failed (${status})`);
}

// --- OAuth token endpoint (plain fetch) --------------------------------------

async function requestToken(
  fetcher: typeof fetch,
  body: Record<string, string>,
  flow: "exchange" | "refresh",
): Promise<OAuthTokenSet> {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError();
  }

  if (response.status === 429) {
    const seconds = rateLimitRetryAfter(Object.fromEntries(response.headers));
    throw new GithubAdapterError(429, "GITHUB_RATE_LIMITED", rateLimitedMessage(seconds), {
      retryAfterSeconds: seconds,
    });
  }
  // A server error or any other non-success status is transient from the
  // platform's point of view and never a revoked grant.
  if (response.status >= 400) {
    throw unavailableError();
  }

  let payload: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // An unparseable body is not usable; treat it as unavailable.
    throw unavailableError();
  }

  if (payload.error !== undefined) {
    const code = typeof payload.error === "string" ? payload.error : "";
    if (flow === "refresh") {
      // Only a genuinely revoked grant asks the user to reconnect. A wrong
      // deployment secret (`incorrect_client_credentials`) or any other error
      // is reported as unavailable so the account is not marked reconnect.
      if (code === "bad_refresh_token" || code === "invalid_grant") {
        throw reauthRequiredError();
      }
      throw unavailableError();
    }
    // Exchange: a wrong deployment secret is unavailable; every other error
    // value is a failed authorization.
    if (code === "incorrect_client_credentials") {
      throw unavailableError();
    }
    throw oauthExchangeFailedError();
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (accessToken === "") {
    // A success status with no usable access token is an unusable body.
    throw unavailableError();
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 0;
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  return {
    accessToken,
    // Absent on a non-rotating refresh response and when token expiry is off
    // (R11): the caller keeps the token it already stored.
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : undefined,
  };
}

// --- per-token Octokit API ----------------------------------------------------

function createGithubApi(
  accessToken: string,
  fetcher: typeof fetch,
  retryBaseMs: number,
): GithubApi {
  // Bound every API request and normalize a timeout into Octokit's network
  // error path (which maps to GITHUB_UNAVAILABLE). Octokit sends no signal of
  // its own, so this never clobbers one.
  const timedFetch: typeof fetch = (input, init) => {
    const nextInit: RequestInit = { ...(init ?? {}) };
    if (!nextInit.signal) nextInit.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetcher(input, nextInit);
  };

  const octokit = new GithubOctokit({
    auth: accessToken,
    request: { fetch: timedFetch },
    // Silence Octokit's own logger (its `warn`/`error` default to the console)
    // so no plugin can ever print a request URL.
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    retry: {
      retries: MAX_RETRIES,
      retryAfterBaseValue: retryBaseMs,
      doNotRetry: DO_NOT_RETRY,
    },
    throttle: {
      id: `sourceweft-github-${throttleInstanceSeq++}`,
      retryAfterBaseValue: retryBaseMs,
      onRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
        retryCount < 1 && retryAfter <= THROTTLE_MAX_RETRY_AFTER_SECONDS,
      onSecondaryRateLimit: (
        retryAfter: number,
        _options: unknown,
        _octokit: unknown,
        retryCount: number,
      ) => retryCount < 1 && retryAfter <= THROTTLE_MAX_RETRY_AFTER_SECONDS,
    },
  });

  async function rest<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw mapOctokitError(error);
    }
  }

  /** One GraphQL call. A response carrying partial `data` alongside `errors`
   * is surfaced by Octokit as a `GraphqlResponseError`; the plan requires the
   * data to be used, so that error's `.data` is returned rather than thrown
   * (and its message, which would echo the GraphQL errors, is never leaked). */
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      return await octokit.graphql<T>(query, variables);
    } catch (error) {
      if (error instanceof Error && error.name === "GraphqlResponseError") {
        return (error as unknown as { data: T }).data;
      }
      throw mapOctokitError(error);
    }
  }

  return {
    async getUser() {
      const response = await rest(() => octokit.request("GET /user"));
      const data = response.data as { id?: unknown; login?: unknown; email?: unknown };
      const id = num(data.id);
      const login = str(data.login);
      // A success response that carries no real account id or login is a
      // malformed answer, not a usable identity.
      if (!Number.isInteger(id) || id < 1 || login === "") {
        throw unavailableError();
      }
      return { id, login, email: strOrNull(data.email) };
    },

    async listInstallations(page) {
      const response = await rest(() =>
        octokit.request("GET /user/installations", { per_page: PER_PAGE, page }),
      );
      const data = response.data as unknown as {
        total_count?: unknown;
        installations?: Array<{ id?: unknown; account?: { login?: unknown; type?: unknown } | null }>;
      };
      const installations = (data.installations ?? []).map((installation) => ({
        id: num(installation?.id),
        login: str(installation?.account?.login),
        type: str(installation?.account?.type),
      }));
      return { installations, hasMore: page * PER_PAGE < num(data.total_count) };
    },

    async listInstallationRepositories(installationId, page) {
      const response = await rest(() =>
        octokit.request("GET /user/installations/{installation_id}/repositories", {
          installation_id: installationId,
          per_page: PER_PAGE,
          page,
        }),
      );
      const data = response.data as unknown as {
        total_count?: unknown;
        repositories?: Array<{
          node_id?: unknown;
          name?: unknown;
          full_name?: unknown;
          updated_at?: unknown;
        }>;
      };
      const repositories = (data.repositories ?? []).map((repository) => ({
        nodeId: str(repository?.node_id),
        name: str(repository?.name),
        fullName: str(repository?.full_name),
        updatedAt: strOrNull(repository?.updated_at),
      }));
      return { repositories, hasMore: page * PER_PAGE < num(data.total_count) };
    },

    async resolveRepositories(ids) {
      if (ids.length === 0) return [];
      const data = await graphql<{ nodes?: RepositoryNode[] }>(RESOLVE_REPOSITORIES_QUERY, {
        ids: [...ids],
      });
      // A missing/null `data`, or a `nodes` that is not an array, is a failed
      // answer; it must never be read as "every repository is gone".
      if (!data || !Array.isArray(data.nodes)) {
        throw unavailableError();
      }
      const nodes = data.nodes;
      return ids.map((_, index) => mapRepositoryNode(nodes[index]));
    },

    async searchIssues(q, perPage, page) {
      const response = await rest(() =>
        octokit.request("GET /search/issues", { q, per_page: perPage, page }),
      );
      const data = response.data as unknown as { total_count?: unknown; items?: RestIssueLike[] };
      return {
        items: (data.items ?? []).map(mapSearchItem),
        totalCount: num(data.total_count),
      };
    },

    async searchDiscussions(q, first, after) {
      const data = await graphql<{
        search?: {
          pageInfo?: { endCursor?: unknown; hasNextPage?: unknown } | null;
          nodes?: DiscussionNode[];
        };
      }>(SEARCH_DISCUSSIONS_QUERY, { q, first, after });
      const search = data?.search;
      // A missing/null answer, or a `nodes` that is not an array, is a failed
      // search; it must never be read as a legitimately empty page.
      if (!search || !Array.isArray(search.nodes)) {
        throw unavailableError();
      }
      const items: GithubDiscussionSearchItem[] = [];
      for (const node of search.nodes) {
        const mapped = mapDiscussionSearchNode(node);
        if (mapped) items.push(mapped);
      }
      return {
        items,
        endCursor: strOrNull(search.pageInfo?.endCursor),
        hasNextPage: search.pageInfo?.hasNextPage === true,
      };
    },

    async getIssue(owner, repo, issueNumber) {
      const response = await rest(() =>
        octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          owner,
          repo,
          issue_number: issueNumber,
        }),
      );
      return mapIssueLike(response.data as unknown as RestIssueLike);
    },

    async listIssueComments(owner, repo, issueNumber, perPage) {
      const response = await rest(() =>
        octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: perPage,
        }),
      );
      const data = response.data as unknown as Array<Parameters<typeof mapComment>[0]>;
      return (Array.isArray(data) ? data : []).map(mapComment);
    },

    async getPull(owner, repo, pullNumber) {
      const response = await rest(() =>
        octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner,
          repo,
          pull_number: pullNumber,
        }),
      );
      return mapPull(response.data as unknown as RestPull);
    },

    async getDiscussion(owner, repo, discussionNumber, commentCount) {
      const data = await graphql<{
        repository?: {
          discussion?:
            | (DiscussionNode & { comments?: { totalCount?: unknown; nodes?: unknown } | null })
            | null;
        } | null;
      }>(GET_DISCUSSION_QUERY, { owner, repo, number: discussionNumber, comments: commentCount });
      const discussion = data?.repository?.discussion;
      if (!discussion) {
        throw new GithubAdapterError(404, "GITHUB_NOT_FOUND", GITHUB_NOT_FOUND_MESSAGE);
      }
      const commentNodes = Array.isArray(discussion.comments?.nodes)
        ? (discussion.comments?.nodes as Array<Parameters<typeof mapComment>[0]>)
        : [];
      return {
        number: num(discussion.number),
        title: str(discussion.title),
        url: str(discussion.url),
        authorLogin: actorLogin(discussion.author),
        labels: graphqlLabels(discussion.labels),
        commentCount: num(discussion.comments?.totalCount),
        createdAt: strOrNull(discussion.createdAt),
        updatedAt: strOrNull(discussion.updatedAt),
        body: strOrNull(discussion.body),
        comments: commentNodes.map(mapComment),
      };
    },
  };
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const {
    clientId,
    clientSecret,
    fetcher = fetch,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
  } = options;

  return {
    exchangeAuthorizationCode(code, redirectUri) {
      return requestToken(
        fetcher,
        { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
        "exchange",
      );
    },
    refreshAccessToken(refreshToken) {
      return requestToken(
        fetcher,
        {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        "refresh",
      );
    },
    forToken(accessToken) {
      return createGithubApi(accessToken, fetcher, retryBaseMs);
    },
  };
}

const RESOLVE_REPOSITORIES_QUERY = `
  query ResolveRepositories($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Repository {
        id
        nameWithOwner
        name
        url
        description
        isPrivate
        isArchived
        defaultBranchRef { name }
      }
    }
  }
`;

const SEARCH_DISCUSSIONS_QUERY = `
  query SearchDiscussions($q: String!, $first: Int!, $after: String) {
    search(type: DISCUSSION, query: $q, first: $first, after: $after) {
      pageInfo { endCursor hasNextPage }
      nodes {
        ... on Discussion {
          number
          title
          url
          body
          createdAt
          updatedAt
          author { login }
          repository { id nameWithOwner }
          comments { totalCount }
          labels(first: 20) { nodes { name } }
        }
      }
    }
  }
`;

const GET_DISCUSSION_QUERY = `
  query GetDiscussion($owner: String!, $repo: String!, $number: Int!, $comments: Int!) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) {
        number
        title
        url
        body
        createdAt
        updatedAt
        author { login }
        labels(first: 20) { nodes { name } }
        comments(first: $comments) {
          totalCount
          nodes { body createdAt url author { login } }
        }
      }
    }
  }
`;
