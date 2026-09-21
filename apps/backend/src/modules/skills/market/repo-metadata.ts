import { and, asc, eq, sql } from "drizzle-orm";
import { db, skillDefinitions, skillRepositories } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  githubDownloadHeaders,
  githubFetch,
} from "../../market/parser/github";

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
  typeof value === "number" || typeof value === "string"
    ? String(value)
    : null;

export async function refreshSkillRepositoryMetadata(
  options: { batchSize?: number; deps?: RepoMetadataDeps } = {},
): Promise<{
  refreshed: number;
  notModified: number;
  missing: number;
  failed: number;
}> {
  const deps = options.deps ?? defaultDeps;
  const result = { refreshed: 0, notModified: 0, missing: 0, failed: 0 };

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
    if (response.status === 304) {
      result.notModified += 1;
      await db
        .update(skillRepositories)
        .set({ fetchedAt: new Date() })
        .where(key);
      continue;
    }
    if (response.status === 403 || response.status === 429) {
      // Out of rate limit (githubFetch already waited what it could). Every
      // request after this one would fail the same way; the rest of the batch
      // keeps its place for the next pass.
      result.failed += 1;
      break;
    }
    if (!response.ok) {
      // 404 included: the row and the skills stay as they are.
      if (response.status === 404) result.missing += 1;
      else result.failed += 1;
      await db
        .update(skillRepositories)
        .set({ fetchedAt: new Date() })
        .where(key);
      continue;
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
      continue;
    }
    const ownerType = body.owner?.type;
    await db
      .update(skillRepositories)
      .set({
        githubId: idText(body.id),
        ownerGithubId: idText(body.owner?.id),
        ownerType:
          ownerType === "User" || ownerType === "Organization"
            ? ownerType
            : null,
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
