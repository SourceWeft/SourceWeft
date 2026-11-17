import {
  GITHUB_MAX_SELECTED_REPOSITORIES,
  GITHUB_NODE_ID_PATTERN,
} from "./contribution";
import { GithubAdapterError } from "./errors";

const NODE_ID_REGEX = new RegExp(GITHUB_NODE_ID_PATTERN);

export type GithubSelectionItem = {
  id: string;
  kind: "repository";
};

function invalidSelection(reason: string): never {
  throw new GithubAdapterError(
    400,
    "GITHUB_INVALID_SELECTION",
    `Invalid GitHub connector selection: ${reason}`,
  );
}

/** Validates and normalizes a connector config's `items` array. A missing
 * `items` is an empty selection; anything malformed, duplicated, or over the
 * cap throws rather than silently dropping entries. */
export function parseGithubSelection(
  config: Record<string, unknown>,
): GithubSelectionItem[] {
  const rawItems = config.items;
  if (rawItems === undefined || rawItems === null) {
    return [];
  }
  if (!Array.isArray(rawItems)) {
    invalidSelection("items must be an array");
  }

  if (rawItems.length > GITHUB_MAX_SELECTED_REPOSITORIES) {
    invalidSelection(
      `at most ${GITHUB_MAX_SELECTED_REPOSITORIES} items are allowed`,
    );
  }

  const seen = new Set<string>();
  const items: GithubSelectionItem[] = [];
  for (const rawItem of rawItems) {
    if (
      typeof rawItem !== "object" ||
      rawItem === null ||
      Array.isArray(rawItem)
    ) {
      invalidSelection("each item must be an object");
    }
    const record = rawItem as Record<string, unknown>;
    const { id, kind } = record;
    if (typeof id !== "string" || !NODE_ID_REGEX.test(id)) {
      invalidSelection("each item's id must be a valid repository node id");
    }
    if (kind !== "repository") {
      invalidSelection('each item\'s kind must be "repository"');
    }
    if (seen.has(id)) {
      invalidSelection("item ids must be unique");
    }
    seen.add(id);
    items.push({ id, kind: "repository" });
  }

  return items;
}

const SCOPE_QUALIFIER_REGEX = /(^|\s)-?(repo|org|user|owner):/i;

/** Validates the agent-supplied free-text search query. Qualifiers such as
 * `repo:`/`org:`/`user:`/`owner:` are rejected because results are already
 * scoped to the connector's selected repositories. */
export function assertAgentQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new GithubAdapterError(
      400,
      "GITHUB_INVALID_REQUEST",
      "Invalid GitHub request",
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new GithubAdapterError(
      400,
      "GITHUB_INVALID_REQUEST",
      "Invalid GitHub request",
    );
  }
  if (SCOPE_QUALIFIER_REGEX.test(trimmed)) {
    throw new GithubAdapterError(
      400,
      "GITHUB_INVALID_REQUEST",
      "Do not put repo:, org: or user: in the query. Use the repository parameter to search one selected repository.",
    );
  }
  return trimmed;
}

export type SearchKind = "issue" | "pull_request" | "discussion";

/** Builds the provider-facing search query text from the agent's query and
 * the requested kind/state, before any `repo:` qualifiers are appended. */
export function buildBaseQuery(input: {
  query: string;
  kind: SearchKind;
  state?: "open" | "closed";
}): string {
  const { query, kind, state } = input;
  let base: string;
  if (kind === "issue") {
    base = `${query} is:issue`;
  } else if (kind === "pull_request") {
    base = `${query} is:pr`;
  } else {
    base = query;
  }
  if (state !== undefined) {
    base = `${base} state:${state}`;
  }
  return base;
}

export type PackedQuery = {
  q: string;
  repositories: string[];
};

export type PackRepositoryQueriesResult = {
  queries: PackedQuery[];
  skipped: string[];
};

const DEFAULT_PACK_LIMITS = { maxLength: 256, maxQueries: 5 };

/** Packs a base search query with as many ` repo:<owner/name>` qualifiers as
 * fit into at most `maxQueries` provider queries of at most `maxLength`
 * characters each, in the given repository order. A repository is appended
 * to the current (last) query if it fits there; otherwise a new query is
 * started if one is still available. A repository that does not fit even in
 * a fresh query, or that arrives once all queries are full, is reported in
 * `skipped` rather than silently dropped. */
export function packRepositoryQueries(
  base: string,
  repositories: readonly string[],
  limits?: { maxLength: number; maxQueries: number },
): PackRepositoryQueriesResult {
  const { maxLength, maxQueries } = limits ?? DEFAULT_PACK_LIMITS;
  const queries: PackedQuery[] = [];
  const skipped: string[] = [];

  for (const repository of repositories) {
    const qualifier = ` repo:${repository}`;
    const current = queries[queries.length - 1];
    if (current && current.q.length + qualifier.length <= maxLength) {
      current.q += qualifier;
      current.repositories.push(repository);
      continue;
    }

    if (queries.length >= maxQueries) {
      skipped.push(repository);
      continue;
    }

    if (base.length + qualifier.length > maxLength) {
      skipped.push(repository);
      continue;
    }

    queries.push({ q: base + qualifier, repositories: [repository] });
  }

  return { queries, skipped };
}

/** Interleaves several batches of already-ordered results one column at a
 * time (round robin), stopping as soon as `limit` items have been taken. */
export function mergeRoundRobin<T>(
  batches: readonly T[][],
  limit: number,
): T[] {
  const result: T[] = [];
  let column = 0;
  let tookAny = true;
  while (result.length < limit && tookAny) {
    tookAny = false;
    for (const batch of batches) {
      if (column < batch.length) {
        result.push(batch[column] as T);
        tookAny = true;
        if (result.length >= limit) {
          break;
        }
      }
    }
    column += 1;
  }
  return result;
}

export type SearchCursor = {
  page?: number;
  after?: Array<string | null>;
};

function invalidCursor(): never {
  throw new GithubAdapterError(
    400,
    "GITHUB_INVALID_REQUEST",
    "Invalid GitHub request",
  );
}

/** Encodes a search cursor as an opaque base64url JSON string. */
export function encodeSearchCursor(value: SearchCursor): string {
  const payload: Record<string, unknown> = {};
  if (value.page !== undefined) {
    payload.page = value.page;
  }
  if (value.after !== undefined) {
    payload.after = value.after;
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes and validates a search cursor. `undefined` (no cursor supplied)
 * decodes to `null`; anything that fails to decode, or whose shape is out of
 * bounds, throws `400 GITHUB_INVALID_REQUEST` rather than being accepted. */
export function decodeSearchCursor(value: unknown): SearchCursor | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    invalidCursor();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    invalidCursor();
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    invalidCursor();
  }
  const record = parsed as Record<string, unknown>;

  let page: number | undefined;
  if (record.page !== undefined) {
    if (
      typeof record.page !== "number" ||
      !Number.isInteger(record.page) ||
      record.page < 2 ||
      record.page > 100
    ) {
      invalidCursor();
    }
    page = record.page;
  }

  let after: Array<string | null> | undefined;
  if (record.after !== undefined) {
    if (
      !Array.isArray(record.after) ||
      record.after.length > 5 ||
      !record.after.every((entry) => entry === null || typeof entry === "string")
    ) {
      invalidCursor();
    }
    after = record.after as Array<string | null>;
  }

  return { page, after };
}

/** Cuts `value` to at most `max` characters, flagging whether it was cut.
 * `null`/`undefined` is treated as an empty, untruncated body. */
export function truncateText(
  value: string | null | undefined,
  max: number,
): { text: string; truncated: boolean } {
  if (value === null || value === undefined) {
    return { text: "", truncated: false };
  }
  if (value.length <= max) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, max), truncated: true };
}

const API_REPO_URL_REGEX = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/;

/** Extracts `owner/name` from a GitHub REST API repository URL (as returned
 * by `repository_url` on search results). Any other host or shape is not a
 * repository API URL and yields `null`. */
export function repositoryNameFromApiUrl(url: string): string | null {
  const match = API_REPO_URL_REGEX.exec(url);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}
