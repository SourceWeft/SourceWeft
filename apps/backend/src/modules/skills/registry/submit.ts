import type { SkillManifestJson } from "@sourceweft/db";
import { SkillParseError } from "../frontmatter";
import { SCAN_RULE_VERSION } from "./scan";
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

export type RegistrySkillSubmissionResult =
  import("@sourceweft/contracts").RegistrySkillResult;
export type SubmitRegistryResult =
  import("@sourceweft/contracts").SubmitRegistrySkillResponse;

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
  const read = await readRegistrySkillsFromGitHub(input.repoUrl);

  const { source, commitSha } = read;
  const { owner, repo, repoUrl } = source;
  const version = commitSha.slice(0, VERSION_SHA_PREFIX_LENGTH);

  const results: RegistrySkillSubmissionResult[] = [];
  // The slug is derived from the frontmatter `name`, so two skills in one repo
  // declaring the same name would upsert onto each other. That repo is
  // malformed by the agentskills.io spec (`name` is the skill's identity); skip
  // the later one rather than let it silently overwrite the first.
  const seenSlugs = new Set<string>();
  for (const discovered of read.skills) {
    try {
      const analyzed = analyzeRegistrySkill({ owner, repo, discovered });
      if (seenSlugs.has(analyzed.slug)) {
        throw new RegistrySubmissionError(
          "REGISTRY_DUPLICATE_NAME",
          "Another skill in this submission has the same name",
        );
      }
      seenSlugs.add(analyzed.slug);

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
          ingestion: {
            formatVersion: 1,
            analyzedAt: new Date().toISOString(),
            parserVersion: "1",
            scanRuleVersion: SCAN_RULE_VERSION,
            diagnostics: analyzed.diagnostics,
            findings: analyzed.findings,
          },
          ...(analyzed.license ? { license: analyzed.license } : {}),
          fileManifest: analyzed.fileManifest,
        },
      };

      const saved = await upsertRegistrySkillIndex({
        slug: analyzed.slug,
        displayName: analyzed.displayName,
        description: analyzed.description,
        submitterId: input.userId,
        storagePointer,
        commitSha,
        contentHash: analyzed.contentSha256,
        manifestJson,
        files: discovered.files.map((file) => ({
          path: file.bundlePath,
          contentText: file.contentText,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          contentHash: file.sha256,
        })),
        versionStatus: decision.versionStatus,
        outcome: decision.outcome,
      });

      results.push({
        slug: analyzed.slug,
        name: analyzed.name,
        sourcePath: discovered.repoSubpath,
        skillVersionId: saved.skillVersionId,
        version: saved.version,
        status: saved.status,
        flags: saved.flags,
        diagnostics: saved.diagnostics,
      });
    } catch (error) {
      if (
        !(error instanceof RegistrySubmissionError) &&
        !(error instanceof SkillParseError)
      )
        throw error;
      results.push({
        sourcePath: discovered.repoSubpath,
        status: "failed",
        flags: [],
        diagnostics: [
          {
            code: error.code,
            severity: "error",
            message: error.message,
            file: "SKILL.md",
            ...(error instanceof SkillParseError
              ? { line: error.line, column: error.column }
              : {}),
          },
        ],
      });
    }
  }

  const accepted = results.filter((item) => item.status !== "failed");
  if (accepted.length === 0) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_NOT_SKILL",
      `No valid skill could be indexed from ${input.repoUrl}`,
      { skills: results },
    );
  }

  const status = accepted.every((result) => result.status === "indexed")
    ? "indexed"
    : "queued";
  logger.info("Registry skill submission processed", {
    repoUrl: input.repoUrl,
    submittedBy: input.userId,
    status,
    skills: results.length,
  });
  return { status, slug: accepted[0]?.slug, skills: results };
}
