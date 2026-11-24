import { GithubAdapterError } from "./errors";
import type {
  GithubApi,
  GithubComment,
  GithubDiscussionSearchItem,
  GithubIssueSearchItem,
  GithubRepository,
} from "./github-client";
import {
  assertAgentQuery,
  buildBaseQuery,
  decodeSearchCursor,
  encodeSearchCursor,
  mergeRoundRobin,
  packRepositoryQueries,
  parseGithubSelection,
  repositoryNameFromApiUrl,
  truncateText,
  type GithubSelectionItem,
  type SearchCursor,
  type SearchKind,
} from "./scope";

/**
 * The three agent-visible GitHub tools: search issues/PRs/discussions, read one
 * item, and list the selected repositories. Scope is enforced twice — every
 * provider query is limited to the selected repositories, and every returned
 * record is re-checked against them (issues/PRs by `repository_url`
 * owner/name, discussions by repository node id) before it is returned. A
 * record whose repository cannot be determined is out of scope and dropped.
 */

/** The most rows one page returns across every packed query, and the point at
 * which the round-robin merge stops. */
const SEARCH_MERGE_LIMIT = 20;
/** A lone query may take the whole page budget. */
const SINGLE_QUERY_PER_PAGE = 20;
/** The REST search API never serves beyond the first 1,000 results. */
const SEARCH_RESULT_CEILING = 1_000;

/** Per-query page size: a single query takes the whole page budget; several
 * split it evenly (floored) so that every row fetched across the queries fits
 * inside the merge limit and none is cut. */
function perQueryPageSize(queryCount: number): number {
  return queryCount <= 1
    ? SINGLE_QUERY_PER_PAGE
    : Math.floor(SEARCH_MERGE_LIMIT / queryCount);
}
const BODY_MAX = 20_000;
/** The item body has its own limit; comment bodies are cut at this one. */
const COMMENT_MAX = 4_000;
const READ_COMMENT_COUNT = 20;
const COMMENTS_TRUNCATED_THRESHOLD = 20;

/** `owner/name` from an issue/PR `html_url` (`github.com/<owner>/<repo>/…`),
 * used to re-check a read item's repository after a possible rename redirect. */
const HTML_REPO_URL_REGEX = /^https:\/\/github\.com\/([^/]+)\/([^/]+)/;

function invalidRequest(message = "Invalid GitHub request"): never {
  throw new GithubAdapterError(400, "GITHUB_INVALID_REQUEST", message);
}

function notFound(message: string): never {
  throw new GithubAdapterError(404, "GITHUB_NOT_FOUND", message);
}

type SearchResultItem = {
  type: SearchKind;
  repository: string;
  number: number;
  title: string;
  state: string;
  url: string;
  author: string | null;
  labels: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};

// --- guards ------------------------------------------------------------------

/** Guard 1: a connector with nothing selected makes no provider request. */
function requireSelection(config: Record<string, unknown>): GithubSelectionItem[] {
  const items = parseGithubSelection(config);
  if (items.length === 0) {
    throw new GithubAdapterError(
      409,
      "GITHUB_NOTHING_SELECTED",
      "No repositories are selected for this GitHub connector. Ask the user to choose repositories in the connector settings.",
    );
  }
  return items;
}

/** Guard 2: resolve the selected node ids. All gone → 404; otherwise keep the
 * ones that still resolve (a removed private repository stops resolving). */
async function resolveSelection(
  api: GithubApi,
  items: readonly GithubSelectionItem[],
): Promise<{ resolved: Array<GithubRepository | null>; available: GithubRepository[] }> {
  const resolved = await api.resolveRepositories(items.map((item) => item.id));
  const available = resolved.filter(
    (repository): repository is GithubRepository => repository !== null,
  );
  if (available.length === 0) {
    throw new GithubAdapterError(
      404,
      "GITHUB_NOT_FOUND",
      "None of the selected repositories can be accessed any more.",
    );
  }
  return { resolved, available };
}

function repositoryName(nameWithOwner: string): string {
  return nameWithOwner.toLowerCase();
}

function repositoryNameFromHtmlUrl(url: string): string | null {
  const match = HTML_REPO_URL_REGEX.exec(url);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function splitOwnerRepo(nameWithOwner: string): { owner: string; repo: string } {
  const slash = nameWithOwner.indexOf("/");
  return { owner: nameWithOwner.slice(0, slash), repo: nameWithOwner.slice(slash + 1) };
}

// --- search ------------------------------------------------------------------

function parseSearchKind(value: unknown): SearchKind {
  if (value === undefined) return "issue";
  if (value === "issue" || value === "pull_request" || value === "discussion") {
    return value;
  }
  invalidRequest();
}

function parseState(value: unknown): "open" | "closed" | undefined {
  if (value === undefined) return undefined;
  if (value === "open" || value === "closed") return value;
  invalidRequest();
}

function mapSearchIssue(
  item: GithubIssueSearchItem,
  repository: string,
): SearchResultItem {
  // The row is labelled by what it is: a search row that carries a
  // pull-request marker is a pull request even when the search was for issues.
  return {
    type: item.isPullRequest ? "pull_request" : "issue",
    repository,
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.htmlUrl,
    author: item.authorLogin,
    labels: item.labels,
    commentCount: item.commentCount,
    createdAt: item.createdAt ?? "",
    updatedAt: item.updatedAt ?? "",
  };
}

function mapSearchDiscussion(
  item: GithubDiscussionSearchItem,
  repository: string,
): SearchResultItem {
  return {
    type: "discussion",
    repository,
    number: item.number,
    title: item.title,
    // Discussion search does not carry an open/closed state.
    state: "",
    url: item.url,
    author: item.authorLogin,
    labels: item.labels,
    commentCount: item.commentCount,
    createdAt: item.createdAt ?? "",
    updatedAt: item.updatedAt ?? "",
  };
}

export async function searchItemsTool(
  api: GithubApi,
  config: Record<string, unknown>,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Selection first (empty → 409, no request), then cheap request validation
  // (so a bad query or `repo:` qualifier is rejected before any request),
  // then resolve, then the repository scope check.
  const items = requireSelection(config);
  const query = assertAgentQuery(request.query);
  const kind = parseSearchKind(request.type);
  const state = parseState(request.state);
  if (state !== undefined && kind === "discussion") {
    // state applies to issues and pull requests only.
    invalidRequest("state applies to issues and pull requests only");
  }
  const cursor = decodeSearchCursor(request.cursor);
  if (cursor) {
    // A cursor belongs to one search kind: issues and pull requests page by
    // number, discussions page by per-query `after`. A cursor of the other
    // kind is rejected rather than silently restarting from the first page.
    const wrongKind =
      kind === "discussion" ? cursor.page !== undefined : cursor.after !== undefined;
    if (wrongKind) invalidRequest();
  }

  const { available } = await resolveSelection(api, items);
  const canonicalByName = new Map<string, string>();
  const canonicalById = new Map<string, string>();
  for (const repository of available) {
    canonicalByName.set(repositoryName(repository.nameWithOwner), repository.nameWithOwner);
    canonicalById.set(repository.id, repository.nameWithOwner);
  }

  let targets: string[];
  if (request.repository !== undefined) {
    if (typeof request.repository !== "string") invalidRequest();
    const canonical = canonicalByName.get(repositoryName(request.repository));
    if (!canonical) {
      notFound("The requested repository is not one of the selected repositories.");
    }
    targets = [canonical];
  } else {
    targets = available.map((repository) => repository.nameWithOwner);
  }

  const base = buildBaseQuery({ query, kind, state });
  const { queries, skipped } = packRepositoryQueries(base, targets);
  const searchedRepositories = queries.flatMap((packed) => packed.repositories);
  const perPage = perQueryPageSize(queries.length);

  if (kind === "discussion") {
    return searchDiscussionItems({
      api,
      queries,
      perPage,
      cursor,
      searchedRepositories,
      skipped,
      canonicalById,
    });
  }

  const page = cursor?.page ?? 1;
  const batches: SearchResultItem[][] = [];
  let anyQueryHasMore = false;
  for (const packed of queries) {
    const { items: rows, totalCount } = await api.searchIssues(packed.q, perPage, page);
    if (totalCount > page * perPage) anyQueryHasMore = true;
    const batch: SearchResultItem[] = [];
    for (const row of rows) {
      const url = row.repositoryUrl;
      const name = url ? repositoryNameFromApiUrl(url) : null;
      // Drop a record whose repository cannot be determined or is out of scope.
      if (!name) continue;
      const canonical = canonicalByName.get(repositoryName(name));
      if (!canonical) continue;
      batch.push(mapSearchIssue(row, canonical));
    }
    batches.push(batch);
  }

  const withinCeiling = page * perPage < SEARCH_RESULT_CEILING;
  const nextCursor =
    anyQueryHasMore && withinCeiling ? encodeSearchCursor({ page: page + 1 }) : null;

  return {
    items: mergeRoundRobin(batches, SEARCH_MERGE_LIMIT),
    nextCursor,
    searchedRepositories,
    skippedRepositories: skipped,
  };
}

async function searchDiscussionItems(input: {
  api: GithubApi;
  queries: Array<{ q: string; repositories: string[] }>;
  perPage: number;
  cursor: SearchCursor | null;
  searchedRepositories: string[];
  skipped: string[];
  canonicalById: Map<string, string>;
}): Promise<Record<string, unknown>> {
  const { api, queries, perPage, cursor, searchedRepositories, skipped, canonicalById } = input;
  const afters = cursor?.after;
  const isContinuation = afters !== undefined;
  const batches: SearchResultItem[][] = [];
  const nextAfters: Array<string | null> = [];

  for (let index = 0; index < queries.length; index += 1) {
    const packed = queries[index];
    if (!packed) continue;
    const after = afters?.[index] ?? null;
    // A query exhausted on an earlier page (its cursor is null in a
    // continuation) is skipped rather than restarted from the top.
    if (isContinuation && after === null) {
      batches.push([]);
      nextAfters.push(null);
      continue;
    }
    const { items, endCursor, hasNextPage } = await api.searchDiscussions(
      packed.q,
      perPage,
      after,
    );
    const batch: SearchResultItem[] = [];
    for (const item of items) {
      // Re-check by repository node id: a discussion is in scope only if its
      // repository is one of the resolved selected repositories. A row whose
      // repository cannot be determined or is out of scope is dropped.
      const canonical = item.repositoryId ? canonicalById.get(item.repositoryId) : undefined;
      if (canonical === undefined) continue;
      batch.push(mapSearchDiscussion(item, canonical));
    }
    batches.push(batch);
    nextAfters.push(hasNextPage ? endCursor : null);
  }

  const anyNext = nextAfters.some((entry) => entry !== null);
  return {
    items: mergeRoundRobin(batches, SEARCH_MERGE_LIMIT),
    nextCursor: anyNext ? encodeSearchCursor({ after: nextAfters }) : null,
    searchedRepositories,
    skippedRepositories: skipped,
  };
}

// --- read --------------------------------------------------------------------

function parseReadType(value: unknown): SearchKind {
  if (value === "issue" || value === "pull_request" || value === "discussion") {
    return value;
  }
  invalidRequest();
}

function mapComment(comment: GithubComment): Record<string, unknown> {
  const body = truncateText(comment.body, COMMENT_MAX);
  return {
    author: comment.authorLogin,
    body: body.text,
    truncated: body.truncated,
    createdAt: comment.createdAt ?? "",
    url: comment.htmlUrl,
  };
}

export async function readItemTool(
  api: GithubApi,
  config: Record<string, unknown>,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const items = requireSelection(config);
  if (typeof request.repository !== "string") invalidRequest();
  const number = request.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    invalidRequest();
  }
  const type = parseReadType(request.type);

  const { available } = await resolveSelection(api, items);
  const canonicalByName = new Map<string, string>();
  const idByName = new Map<string, string>();
  for (const repository of available) {
    canonicalByName.set(repositoryName(repository.nameWithOwner), repository.nameWithOwner);
    idByName.set(repositoryName(repository.nameWithOwner), repository.id);
  }
  const canonical = canonicalByName.get(repositoryName(request.repository));
  if (!canonical) {
    notFound("The requested repository is not one of the selected repositories.");
  }
  const resolvedId = idByName.get(repositoryName(canonical));
  const { owner, repo } = splitOwnerRepo(canonical);

  if (type === "discussion") {
    const discussion = await api.getDiscussion(owner, repo, number, READ_COMMENT_COUNT);
    // Re-check the item's own repository node id against the selected
    // repository, the same scope guard the search and issue paths apply.
    if (!discussion.repositoryId || discussion.repositoryId !== resolvedId) {
      notFound("The requested item is not in the selected repository.");
    }
    const body = truncateText(discussion.body, BODY_MAX);
    return {
      type: "discussion",
      repository: canonical,
      number: discussion.number,
      title: discussion.title,
      state: "",
      url: discussion.url,
      author: discussion.authorLogin,
      labels: discussion.labels,
      assignees: [],
      createdAt: discussion.createdAt ?? "",
      updatedAt: discussion.updatedAt ?? "",
      body: body.text,
      bodyTruncated: body.truncated,
      comments: discussion.comments.map(mapComment),
      commentCount: discussion.commentCount,
      commentsTruncated: discussion.commentCount > COMMENTS_TRUNCATED_THRESHOLD,
    };
  }

  const issue = await api.getIssue(owner, repo, number);
  // A rename redirect can answer from a different repository; the item's
  // own repository must still be the selected one, else it is out of scope.
  const answered = repositoryNameFromHtmlUrl(issue.htmlUrl);
  if (!answered || repositoryName(answered) !== repositoryName(canonical)) {
    notFound("The requested item is not in the selected repository.");
  }
  const actualType: SearchKind = issue.isPullRequest ? "pull_request" : "issue";
  const comments = await api.listIssueComments(owner, repo, number, READ_COMMENT_COUNT);
  const body = truncateText(issue.body, BODY_MAX);

  const result: Record<string, unknown> = {
    type: actualType,
    repository: canonical,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.htmlUrl,
    author: issue.authorLogin,
    labels: issue.labels,
    assignees: issue.assignees,
    createdAt: issue.createdAt ?? "",
    updatedAt: issue.updatedAt ?? "",
    body: body.text,
    bodyTruncated: body.truncated,
    comments: comments.map(mapComment),
    commentCount: issue.commentCount,
    commentsTruncated: issue.commentCount > COMMENTS_TRUNCATED_THRESHOLD,
  };

  if (actualType === "pull_request") {
    const pull = await api.getPull(owner, repo, number);
    result.pullRequest = {
      merged: pull.merged,
      draft: pull.draft,
      baseBranch: pull.baseRef ?? "",
      headBranch: pull.headRef ?? "",
      changedFiles: pull.changedFiles,
      additions: pull.additions,
      deletions: pull.deletions,
    };
  }

  return result;
}

// --- list --------------------------------------------------------------------

export async function listRepositoriesTool(
  api: GithubApi,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const items = requireSelection(config);
  const { resolved, available } = await resolveSelection(api, items);
  const repositories = available.map((repository) => ({
    name: repository.nameWithOwner,
    description: repository.description,
    visibility: repository.isPrivate ? "private" : "public",
    defaultBranch: repository.defaultBranch,
    archived: repository.isArchived,
    url: repository.url,
  }));
  return {
    repositories,
    unavailableCount: resolved.length - available.length,
  };
}
