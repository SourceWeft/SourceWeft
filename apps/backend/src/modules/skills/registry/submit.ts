import type { SkillManifestJson } from "@sourceweft/db";
import { cleanupGitHubRepository } from "../../market/parser/github";
import { logger } from "../../../shared/logger";
import { analyzeRegistrySkill } from "./analyze";
import { RegistrySubmissionError } from "./errors";
import { triageRegistrySubmission } from "./guard";
import {
  getRegistrySkillForSubmission,
  upsertRegistrySkillIndex,
} from "./repository";
import { readRegistrySkillsFromGitHub } from "./read";

/**
 * Stage 1 (entry) + orchestration of the submit → read → analyze → guard →
 * index pipeline (docs/architecture/skill-registry-index.md §3 / build phase
 * R2). Counterpart to `market/submission.ts`'s `submitMcpFromGitHub`.
 */

const VERSION_SHA_PREFIX_LENGTH = 12;

export type RegistrySkillSubmissionResult = {
  slug: string;
  status: "indexed" | "queued";
  flags: string[];
};

export type SubmitRegistryResult = {
  status: "indexed" | "queued";
  slug?: string;
  skills: RegistrySkillSubmissionResult[];
};

function skillSourceUrl(
  repoUrl: string,
  sha: string,
  repoSubpath: string,
): string {
  return repoSubpath
    ? `${repoUrl}/tree/${sha}/${repoSubpath}`
    : `${repoUrl}/tree/${sha}`;
}

export async function submitRegistrySkillFromGitHub(input: {
  repoUrl: string;
  userId: string;
}): Promise<SubmitRegistryResult> {
  let read;
  try {
    read = await readRegistrySkillsFromGitHub(input.repoUrl);
  } catch (error) {
    if (error instanceof RegistrySubmissionError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_NOT_SKILL",
      `Could not read a skill from ${input.repoUrl}: ${message}`,
    );
  }

  const { source, commitSha } = read;
  const { owner, repo, repoUrl } = source;
  const version = commitSha.slice(0, VERSION_SHA_PREFIX_LENGTH);

  try {
    const results: RegistrySkillSubmissionResult[] = [];
    for (const discovered of read.skills) {
      let analyzed;
      try {
        analyzed = analyzeRegistrySkill({ owner, repo, discovered });
      } catch (error) {
        // A malformed skill among several does not fail the whole submission;
        // it is skipped and the rest still index (§3 Stage 2 "multiple skills").
        if (error instanceof RegistrySubmissionError) {
          logger.warn("Skipping invalid registry skill", {
            repoUrl: input.repoUrl,
            repoSubpath: discovered.repoSubpath,
            code: error.code,
          });
          continue;
        }
        throw error;
      }

      const existing = await getRegistrySkillForSubmission(analyzed.slug);
      // triage throws REGISTRY_SUBMISSION_CONFLICT on an ownership violation.
      const decision = triageRegistrySubmission({
        existing,
        submitterId: input.userId,
        scan: analyzed.scan,
      });

      const storagePointer = `github:${owner}/${repo}@${commitSha}${
        analyzed.repoSubpath ? `#${analyzed.repoSubpath}` : ""
      }`;

      const manifestJson: SkillManifestJson = {
        slug: analyzed.slug,
        displayName: analyzed.displayName,
        version,
        description: analyzed.description,
        // Trust firewall (§0/§3): registry entries are never first-party. The
        // definition starts `restricted`; the catalog tags them Community +
        // unverified. No `official`/`verified` is ever self-asserted here.
        visibility: "restricted",
        categories: [],
        registry: {
          identifier: `gh:${owner}/${repo}${
            analyzed.repoSubpath ? `/${analyzed.repoSubpath}` : ""
          }`,
          sourceUrl: skillSourceUrl(repoUrl, commitSha, analyzed.repoSubpath),
          repoUrl,
          submittedBy: input.userId,
          capability: analyzed.capability,
          scan: analyzed.scan,
          ...(analyzed.license ? { license: analyzed.license } : {}),
          fileManifest: analyzed.fileManifest,
        },
      };

      await upsertRegistrySkillIndex({
        slug: analyzed.slug,
        displayName: analyzed.displayName,
        description: analyzed.description,
        submitterId: input.userId,
        storagePointer,
        commitSha,
        contentHash: analyzed.contentSha256,
        manifestJson,
        versionStatus: decision.versionStatus,
        outcome: decision.outcome,
      });

      results.push({
        slug: analyzed.slug,
        status: decision.outcome,
        flags: analyzed.scan.flags,
      });
    }

    if (results.length === 0) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_NOT_SKILL",
        `No valid skill could be indexed from ${input.repoUrl}`,
      );
    }

    const status = results.every((result) => result.status === "indexed")
      ? "indexed"
      : "queued";
    logger.info("Registry skill submission processed", {
      repoUrl: input.repoUrl,
      submittedBy: input.userId,
      status,
      skills: results.length,
    });
    return { status, slug: results[0]?.slug, skills: results };
  } finally {
    // The extracted repo is a transient analysis copy — never leave third-party
    // source lingering in os.tmpdir() (§3 Stage 5 "delete the temp dir").
    await cleanupGitHubRepository(source);
  }
}
