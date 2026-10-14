import { and, asc, eq, sql } from "drizzle-orm";
import { db, skillDefinitions, skillRepositories } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  githubDownloadHeaders,
  githubFetch,
  githubRateLimitBudget,
  githubRateLimitResetAt,
  GitHubRateLimitedError,
  isGitHubRateLimitResponse,
} from "../../market/parser/github";
import type { GitHubRateLimitBudget } from "../../market/parser/github";

/**
 * GitHub's facts about the repositories community skills come from — stars,
 * forks, last push, archived — kept in `skill_repositories` and refreshed a
 * batch at a time by the market upkeep, oldest first. Requests are
 * conditional (`If-None-Match` with the stored ETag): an unchanged repository
 * answers 304, which GitHub does not count against the rate limit.
 *
 * Display and ranking only. A repository that is gone (404) keeps its row and
 * its skills stay listed: whether an upstream still exists is deliberately not
 * this pass's question.
 */

/** Repositories read from GitHub in one upkeep pass. */
export const REPO_METADATA_BATCH_SIZE = 30;

/**
 * Requests of the hour's budget this pass leaves for the other GitHub readers
 * (ingest, README fetch): once GitHub reports fewer remaining, the pass stops.
 * Well above a pass's own spend, and still a small share of a token's 5,000;
 * under the anonymous 60 it stops a pass after one request, which is right —
 * without a token this pass cannot keep up anyway, and the log says so.
 */
export const GITHUB_RATE_LIMIT_RESERVE = 100;

export type RepoMetadataDeps = {
  fetch: (url: string, headers: Record<string, string>) => Promise<Response>;
};

const defaultDeps: RepoMetadataDeps = {
  fetch: (url, headers) => githubFetch(url, headers),
};

type GitHubRepository = {
  id?: number | string;
  default_branch?: string;
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string | null;
  archived?: boolean;
  owner?: { id?: number | string; type?: string };
};

// Only an active registry skill makes a repository worth a request.
const hasActiveSkill = sql`exists (
  select 1 from ${skillDefinitions}
  where ${skillDefinitions.repoOwner} = ${skillRepositories.repoOwner}
    and ${skillDefinitions.repoName} = ${skillRepositories.repoName}
    and ${skillDefinitions.sourceType} = 'registry_github'
    and ${skillDefinitions.status} = 'active'
)`;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 2_147_483_647)
    : 0;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const idText = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? String(value) : null;

type RefreshResult = {
  refreshed: number;
  notModified: number;
  missing: number;
  failed: number;
  /**
   * Set when GitHub's rate limit stopped the pass: when it lifts. The
   * repositories not reached keep their place (oldest first) for a later pass.
   */
  rateLimitedUntil?: string;
};

/** Keeps one repository's answer (not a rate-limit refusal) and tallies it. */
async function recordAnswer(
  repository: typeof skillRepositories.$inferSelect,
  key: ReturnType<typeof and>,
  response: Response,
  result: RefreshResult,
): Promise<void> {
  if (response.status === 304) {
    result.notModified += 1;
    await db
      .update(skillRepositories)
      .set({ fetchedAt: new Date() })
      .where(key);
    return;
  }
  if (!response.ok) {
    // 404 included: the row and the skills stay as they are.
    if (response.status === 404) result.missing += 1;
    else result.failed += 1;
    await db
      .update(skillRepositories)
      .set({ fetchedAt: new Date() })
      .where(key);
    return;
  }
  let body: GitHubRepository;
  try {
    body = (await response.json()) as GitHubRepository;
  } catch {
    result.failed += 1;
    await db
      .update(skillRepositories)
      .set({ fetchedAt: new Date() })
      .where(key);
    return;
  }
  const ownerType = body.owner?.type;
  await db
    .update(skillRepositories)
    .set({
      githubId: idText(body.id),
      ownerGithubId: idText(body.owner?.id),
      ownerType:
        ownerType === "User" || ownerType === "Organization" ? ownerType : null,
      defaultBranch:
        typeof body.default_branch === "string"
          ? body.default_branch
          : repository.defaultBranch,
      stars: count(body.stargazers_count),
      forks: count(body.forks_count),
      pushedAt: date(body.pushed_at),
      archived: body.archived === true,
      etag: response.headers.get("etag"),
      fetchedAt: new Date(),
    })
    .where(key);
  result.refreshed += 1;
}

export async function refreshSkillRepositoryMetadata(
  options: { batchSize?: number; deps?: RepoMetadataDeps } = {},
): Promise<RefreshResult> {
  const deps = options.deps ?? defaultDeps;
  const result: RefreshResult = {
    refreshed: 0,
    notModified: 0,
    missing: 0,
    failed: 0,
  };
  // Every request after a rate-limited one would fail the same way: the pass
  // stops, logged once, and the rest of the upkeep carries on. The ceiling
  // tells a token's 5,000/hour from an anonymous 60/hour in the log.
  const stopForRateLimit = (
    resetAt: Date,
    budget: Pick<GitHubRateLimitBudget, "limit" | "remaining">,
  ) => {
    result.rateLimitedUntil = resetAt.toISOString();
    logger.warn(
      "Skill repository metadata refresh stopped: GitHub rate limit reached",
      {
        resetAt: result.rateLimitedUntil,
        limit: budget.limit,
        remaining: budget.remaining,
        refreshed: result.refreshed,
      },
    );
  };

  // A repository a skill was indexed from since the last pass gets its row.
  await db.execute(sql`
    insert into ${skillRepositories} (repo_owner, repo_name)
    select distinct ${skillDefinitions.repoOwner}, ${skillDefinitions.repoName}
    from ${skillDefinitions}
    where ${skillDefinitions.sourceType} = 'registry_github'
      and ${skillDefinitions.status} = 'active'
      and ${skillDefinitions.repoOwner} is not null
      and ${skillDefinitions.repoName} is not null
    on conflict do nothing
  `);

  const batch = await db
    .select()
    .from(skillRepositories)
    .where(hasActiveSkill)
    .orderBy(
      sql`${skillRepositories.fetchedAt} asc nulls first`,
      asc(skillRepositories.repoOwner),
      asc(skillRepositories.repoName),
    )
    .limit(options.batchSize ?? REPO_METADATA_BATCH_SIZE);

  for (const repository of batch) {
    const key = and(
      eq(skillRepositories.repoOwner, repository.repoOwner),
      eq(skillRepositories.repoName, repository.repoName),
    );
    let response: Response;
    try {
      response = await deps.fetch(
        `https://api.github.com/repos/${encodeURIComponent(repository.repoOwner)}/${encodeURIComponent(repository.repoName)}`,
        {
          ...githubDownloadHeaders(),
          Accept: "application/vnd.github+json",
          ...(repository.etag ? { "If-None-Match": repository.etag } : {}),
        },
      );
    } catch (error) {
      if (error instanceof GitHubRateLimitedError) {
        stopForRateLimit(error.resetAt, error);
        break;
      }
      // Unreachable or too slow: tried again on a later pass, after the rest.
      result.failed += 1;
      logger.warn("Skill repository metadata fetch failed", {
        repository: `${repository.repoOwner}/${repository.repoName}`,
        message: error instanceof Error ? error.message : String(error),
      });
      await db
        .update(skillRepositories)
        .set({ fetchedAt: new Date() })
        .where(key);
      continue;
    }
    if (isGitHubRateLimitResponse(response)) {
      // `githubFetch` raises this itself; a fetch handed in may answer it.
      stopForRateLimit(
        githubRateLimitResetAt(response),
        githubRateLimitBudget(response),
      );
      break;
    }
    await recordAnswer(repository, key, response, result);
    // An answer is paid for and kept, but the next request is not sent once
    // what is left of the hour would be taken from the other GitHub readers
    // (ingest, README fetch). GitHub's reset is the hour's; the pass stops
    // there, logged like a spent limit so the two read the same in the log.
    const budget = githubRateLimitBudget(response);
    if (
      budget.remaining !== null &&
      budget.remaining < GITHUB_RATE_LIMIT_RESERVE
    ) {
      stopForRateLimit(
        budget.resetAt ?? githubRateLimitResetAt(response),
        budget,
      );
      break;
    }
  }

  // Backfill stable source identity without overwriting a previously bound ID.
  await db.execute(sql`
    update ${skillDefinitions} d set github_repository_id = r.github_id
    from ${skillRepositories} r
    where d.source_type = 'registry_github' and d.repo_owner = r.repo_owner and d.repo_name = r.repo_name
      and d.github_repository_id is null and r.github_id is not null
  `);

  // Onto the skills, so sorting by stars needs no join.
  await db.execute(sql`
    update ${skillDefinitions} d
    set repo_stars = r.stars
    from ${skillRepositories} r
    where d.repo_owner = r.repo_owner
      and d.repo_name = r.repo_name
      and d.repo_stars <> r.stars
  `);
  return result;
}
