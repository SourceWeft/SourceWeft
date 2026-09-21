import { and, eq, isNull, sql } from "drizzle-orm";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";
import type { SkillManifestJson } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import { ContentError } from "../../content/errors";
import {
  assertCommitOnDefaultBranch,
  GitHubArchiveError,
  resolveDefaultBranch,
} from "../../market/parser/github";
import { setRegistryVisibility } from "../registry/review";
import { parseGithubStoragePointer } from "../storage/source-pointer";

/**
 * Where a community skill's commit came from, before the market shows it to
 * anyone.
 *
 * GitHub serves a commit that exists only in a FORK under the upstream's own
 * URLs, so a version pinned to such a commit would be listed under the
 * upstream's name, author and avatar. Ingest now refuses those (the resolver
 * checks the commit is on the default branch) and stamps
 * `manifestJson.registry.provenance`. Versions indexed before that have no
 * stamp: this module checks them, stamps the ones that pass, and takes the
 * others off the market. Only stamped versions are ever auto-listed.
 */

/** Most unstamped versions checked in one upkeep pass. */
const PROVENANCE_SWEEP_BATCH = 50;

/** Recorded as the actor when a foreign commit is taken off the market. */
export const PROVENANCE_ACTOR = "system:provenance";

export type ProvenanceVerdict = "confirmed" | "foreign" | "unknown";

export type ProvenanceDeps = {
  resolveDefaultBranch: typeof resolveDefaultBranch;
  assertCommitOnDefaultBranch: typeof assertCommitOnDefaultBranch;
};

const defaultDeps: ProvenanceDeps = {
  resolveDefaultBranch,
  assertCommitOnDefaultBranch,
};

/** Checks one version, stamping it when its commit is on the default branch. */
export async function checkVersionProvenance(
  version: {
    id: string;
    storagePointer: string;
    manifestJson: SkillManifestJson;
  },
  deps: ProvenanceDeps = defaultDeps,
): Promise<ProvenanceVerdict> {
  if (version.manifestJson.registry?.provenance) return "confirmed";
  const pointer = parseGithubStoragePointer(version.storagePointer);
  // A registry version always has a GitHub pointer; one that does not cannot
  // be vouched for.
  if (!pointer) return "foreign";
  const source = {
    owner: pointer.owner,
    repo: pointer.repo,
    subpath: pointer.repoSubpath,
    repoUrl: `https://github.com/${pointer.owner}/${pointer.repo}`,
    sourceUrl: `https://github.com/${pointer.owner}/${pointer.repo}`,
  };
  try {
    const defaultBranch = await deps.resolveDefaultBranch(source);
    await deps.assertCommitOnDefaultBranch(
      source,
      pointer.commitSha,
      defaultBranch,
    );
    const registry = version.manifestJson.registry;
    if (registry) {
      await db
        .update(skillVersions)
        .set({
          manifestJson: {
            ...version.manifestJson,
            registry: {
              ...registry,
              provenance: {
                defaultBranch,
                checkedAt: new Date().toISOString(),
              },
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(skillVersions.id, version.id));
    }
    return "confirmed";
  } catch (error) {
    if (
      error instanceof GitHubArchiveError &&
      error.code === "ARCHIVE_NOT_IN_REPOSITORY"
    ) {
      return "foreign";
    }
    // GitHub unreachable, rate limited, repository gone: ask again next pass.
    return "unknown";
  }
}

/**
 * Takes a skill whose current commit is not its repository's off the market
 * and holds it there. Installed workspaces keep it: removing someone's tool is
 * an admin's revoke, not this.
 */
async function withholdForeignSkill(skillId: string, visibility: string) {
  if (visibility === "public") {
    await setRegistryVisibility({
      skillId,
      visibility: "restricted",
      actorUserId: PROVENANCE_ACTOR,
    });
  }
  await db
    .update(skillDefinitions)
    .set({ listingHold: true, listingHoldBy: "admin", updatedAt: new Date() })
    .where(eq(skillDefinitions.id, skillId));
}

/**
 * Checks current versions that carry no provenance stamp — public or not —
 * and withholds any whose commit is not on its repository's default branch.
 */
export async function runProvenanceSweep(
  options: { onlySkillIds?: string[]; deps?: ProvenanceDeps } = {},
): Promise<{ confirmed: number; foreign: number; unknown: number }> {
  const rows = await db
    .select({
      skillId: skillDefinitions.id,
      visibility: skillDefinitions.visibility,
      version: {
        id: skillVersions.id,
        storagePointer: skillVersions.storagePointer,
        manifestJson: skillVersions.manifestJson,
      },
    })
    .from(skillDefinitions)
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.listingHold, false),
        isNull(sql`${skillVersions.manifestJson}->'registry'->'provenance'`),
        options.onlySkillIds
          ? sql`${skillDefinitions.id} in ${options.onlySkillIds}`
          : undefined,
      ),
    )
    .limit(PROVENANCE_SWEEP_BATCH);

  const tally = { confirmed: 0, foreign: 0, unknown: 0 };
  for (const row of rows) {
    const verdict = await checkVersionProvenance(row.version, options.deps);
    tally[verdict] += 1;
    if (verdict === "foreign") {
      await withholdForeignSkill(row.skillId, row.visibility);
      logger.warn(
        "Community skill withheld: its commit is not on its repository's default branch",
        { skillId: row.skillId, storagePointer: row.version.storagePointer },
      );
    }
  }
  return tally;
}

/**
 * For `listSkillPublicly`: an admin listing a skill by hand gets the same
 * check the pass relies on. Throws rather than lists when the commit is not
 * the repository's, or when GitHub cannot say right now.
 */
export async function ensureListingProvenance(
  skillId: string,
  deps: ProvenanceDeps = defaultDeps,
): Promise<void> {
  const [version] = await db
    .select({
      id: skillVersions.id,
      storagePointer: skillVersions.storagePointer,
      manifestJson: skillVersions.manifestJson,
    })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .limit(1);
  // No current version: `setRegistryVisibility` refuses with its own error.
  if (!version) return;
  const verdict = await checkVersionProvenance(version, deps);
  if (verdict === "foreign") {
    throw new ContentError(
      409,
      "SKILL_COMMIT_NOT_IN_REPOSITORY",
      "This skill's commit is not on its repository's default branch (it may come from a fork), so it cannot be listed",
    );
  }
  if (verdict === "unknown") {
    throw new ContentError(
      503,
      "SKILL_PROVENANCE_UNAVAILABLE",
      "GitHub could not confirm where this skill's commit comes from; try again shortly",
    );
  }
}
