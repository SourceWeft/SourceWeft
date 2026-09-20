import type { SkillManifestJson } from "@sourceweft/db";
import { SkillParseError } from "../frontmatter";
import { SCAN_RULE_VERSION } from "./scan";
import { analyzeRegistrySkill, type AnalyzedRegistrySkill } from "./analyze";
import { extractRegistryLogo } from "./logo";
import { RegistrySubmissionError } from "./errors";
import { triageRegistrySubmission } from "./guard";
import {
  getRegistrySkillForSubmission,
  upsertRegistrySkillIndex,
} from "./repository";
import type { DiscoveredSkill, ReadRegistryResult } from "./read";

/**
 * The per-skill work of a registry submission: analyze → guard → index
 * (docs/architecture/skill-registry-index.md §3 / build phase R2).
 *
 * `analyzeSubmittedSkills` / `writeSubmittedSkill` / `summarizeSubmission` are
 * run as separate stages by the asynchronous ingest pipeline (`./ingest`) —
 * the only way a submission is processed — so every skill is analyzed, triaged
 * and stored the same way whether it arrived as a GitHub link or a zip.
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

/** A discovered skill after analysis: ready to write, or already failed. */
export type AnalyzedSubmissionSkill =
  | {
      discovered: DiscoveredSkill;
      analyzed: AnalyzedRegistrySkill;
      logo?: SkillManifestJson["logo"];
    }
  | { discovered: DiscoveredSkill; failure: RegistrySkillSubmissionResult };

/**
 * A per-skill failure is a result, not an abort: the other skills of the same
 * submission still go through. Anything that is not a skill-level error (a
 * database outage, a bug) is rethrown — it says nothing about this skill.
 */
function failedSkillResult(
  discovered: DiscoveredSkill,
  error: unknown,
): RegistrySkillSubmissionResult {
  if (
    !(error instanceof RegistrySubmissionError) &&
    !(error instanceof SkillParseError)
  )
    throw error;
  return {
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
  };
}

/** Stage 3 — analyze + scan every discovered skill. Writes nothing. */
export async function analyzeSubmittedSkills(input: {
  owner: string;
  repo: string;
  skills: DiscoveredSkill[];
}): Promise<AnalyzedSubmissionSkill[]> {
  const { owner, repo } = input;
  const items: AnalyzedSubmissionSkill[] = [];
  // The slug is derived from the frontmatter `name`, so two skills in one repo
  // declaring the same name would upsert onto each other. That repo is
  // malformed by the agentskills.io spec (`name` is the skill's identity); skip
  // the later one rather than let it silently overwrite the first.
  const seenSlugs = new Set<string>();
  for (const discovered of input.skills) {
    try {
      // Over a storage limit: refused by the reader, reported as this skill's
      // failure. Its bundle was never read, so there is nothing to analyze.
      if (discovered.rejection) {
        throw discovered.rejection;
      }
      const analyzed = analyzeRegistrySkill({ owner, repo, discovered });
      const branding = await extractRegistryLogo(discovered);
      analyzed.diagnostics.push(...branding.diagnostics);
      if (seenSlugs.has(analyzed.slug)) {
        throw new RegistrySubmissionError(
          "REGISTRY_DUPLICATE_NAME",
          "Another skill in this submission has the same name",
        );
      }
      seenSlugs.add(analyzed.slug);
      items.push({
        discovered,
        analyzed,
        ...(branding.logo ? { logo: branding.logo } : {}),
      });
    } catch (error) {
      items.push({ discovered, failure: failedSkillResult(discovered, error) });
    }
  }
  return items;
}

/**
 * Stages 4-5 — triage one analyzed skill, store its bundle and write its
 * catalog rows. The only place a submission touches object storage or
 * `skill_definitions` / `skill_versions`. Safe to repeat: objects are
 * content-addressed, and an identical commit returns the version already
 * stored.
 */
export async function writeSubmittedSkill(input: {
  read: Pick<ReadRegistryResult, "source" | "commitSha" | "committedAt">;
  userId: string;
  skill: AnalyzedSubmissionSkill;
}): Promise<RegistrySkillSubmissionResult> {
  if ("failure" in input.skill) {
    return input.skill.failure;
  }
  const { discovered, analyzed, logo } = input.skill;
  const { commitSha, committedAt } = input.read;
  const { owner, repo, repoUrl } = input.read.source;
  try {
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
      ...(logo ? { logo } : {}),
      slug: analyzed.slug,
      displayName: analyzed.displayName,
      version: commitSha.slice(0, VERSION_SHA_PREFIX_LENGTH),
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
        // Orders this commit against the skill's other versions when the
        // index decides which one is current.
        committedAt,
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
      manifestJson,
      // Raw bytes, text and binary alike: the index stores them as blobs and
      // as the bundle, then writes the rows that point at them.
      files: discovered.files.map((file) => ({
        path: file.bundlePath,
        bytes: file.bytes,
        mimeType: file.mimeType,
      })),
      versionStatus: decision.versionStatus,
      outcome: decision.outcome,
    });

    return {
      slug: analyzed.slug,
      name: analyzed.name,
      sourcePath: discovered.repoSubpath,
      skillVersionId: saved.skillVersionId,
      version: saved.version,
      status: saved.status,
      flags: saved.flags,
      diagnostics: saved.diagnostics,
    };
  } catch (error) {
    return failedSkillResult(discovered, error);
  }
}

/**
 * Roll per-skill results up into the submission's outcome. A submission that
 * indexed nothing is an error carrying every skill's diagnostics, so the
 * submitter sees why each one was refused.
 */
export function summarizeSubmission(
  results: RegistrySkillSubmissionResult[],
  sourceLabel: string,
): SubmitRegistryResult {
  const accepted = results.filter((item) => item.status !== "failed");
  if (accepted.length === 0) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_NOT_SKILL",
      `No valid skill could be indexed from ${sourceLabel}`,
      { skills: results },
    );
  }
  const status = accepted.every((result) => result.status === "indexed")
    ? "indexed"
    : "queued";
  return { status, slug: accepted[0]?.slug, skills: results };
}
