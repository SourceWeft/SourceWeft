import type {
  SkillSubmissionOnComplete,
  SkillSubmissionSkillResult,
} from "@sourceweft/db";
import type { compareCommits } from "../../../market/parser/github";
import {
  downloadRepoZip,
  resolvePinnedGitHubSource,
  type PinnedGitHubSource,
} from "../../../market/parser/github-zip";
import { RegistrySubmissionError } from "../errors";
import {
  readRegistrySkillsFromArchive,
  requireCommittedAt,
  type ReadRegistryResult,
} from "../read";
import {
  analyzeSubmittedSkills,
  summarizeSubmission,
  writeSubmittedSkill,
  type AnalyzedSubmissionSkill,
} from "../submit";
import { describeIngestError } from "./errors";
import type { SkillSubmissionRow, SubmissionProgressPatch } from "./repository";

/**
 * The ingest pipeline as an ordered list of named stages. Each stage reads what
 * earlier ones left on the context and adds its own; a future `translate` or
 * `audit` stage is an insertion into `GITHUB_INGEST_STAGES`, ahead of
 * `triage-write` so its verdict can feed triage.
 *
 * Only `triage-write` touches object storage and the catalog, and it runs after
 * everything that can reject the source — a failure in any earlier stage leaves
 * nothing behind.
 */

export type InstallSkillFn = (input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  ref: { kind: "source"; source: string };
  installedVia: "user" | "agent";
}) => Promise<{ skills: Array<{ status: string }> }>;

/** The pipeline's IO seams; tests replace them, production uses the defaults. */
export type IngestDeps = {
  resolveSource: typeof resolvePinnedGitHubSource;
  downloadArchive: typeof downloadRepoZip;
  installSkill: InstallSkillFn;
  /** GitHub's ancestry answer between two commits; defaults to the real API. */
  compareCommits?: typeof compareCommits;
};

export const defaultIngestDeps: IngestDeps = {
  resolveSource: resolvePinnedGitHubSource,
  downloadArchive: downloadRepoZip,
  // Loaded on first use: the skills service imports half the content plane,
  // and most ingests never install anything.
  installSkill: async (input) =>
    (await import("../../service")).contentSkillsService.installSkill(input),
};

export type IngestContext = {
  submission: Pick<
    SkillSubmissionRow,
    "id" | "teamId" | "workspaceId" | "submittedBy" | "sourceInput" | "target"
  > & { onComplete: SkillSubmissionOnComplete | null };
  /** The job's overall deadline. Checked between stages and handed to GitHub. */
  signal: AbortSignal;
  deps: IngestDeps;
  source?: PinnedGitHubSource;
  archive?: Buffer;
  read?: ReadRegistryResult;
  analyzed?: AnalyzedSubmissionSkill[];
  /**
   * Per-skill outcomes. Set as soon as they exist — even by a stage that then
   * fails — so a submission that indexed nothing still shows why.
   */
  results?: SkillSubmissionSkillResult[];
};

export type IngestStage = {
  name: string;
  /**
   * An optional stage's failure is recorded on the stage and the submission
   * still succeeds: what it does is a convenience on top of the ingest, and
   * the catalog rows are already written.
   */
  optional?: boolean;
  /** May return row columns to persist together with the stage's completion. */
  run(ctx: IngestContext): Promise<SubmissionProgressPatch | void>;
};

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Ingest stage order is broken: ${what} is not available`);
  }
  return value;
}

const resolveStage: IngestStage = {
  name: "resolve",
  async run(ctx) {
    ctx.source = await ctx.deps.resolveSource(ctx.submission.sourceInput, {
      signal: ctx.signal,
    });
    // Refused here rather than at the write: an undated commit cannot be
    // ordered against the skill's other versions, so there is no point
    // downloading it.
    const committedAt = requireCommittedAt(ctx.source);
    return {
      commitSha: ctx.source.commitSha,
      commitCommittedAt: new Date(committedAt),
    };
  },
};

const downloadStage: IngestStage = {
  name: "download",
  async run(ctx) {
    // Held on the context, so later stages of this run never fetch it again.
    ctx.archive = await ctx.deps.downloadArchive(need(ctx.source, "source"), {
      signal: ctx.signal,
    });
  },
};

const discoverStage: IngestStage = {
  name: "discover",
  async run(ctx) {
    ctx.read = await readRegistrySkillsFromArchive(
      need(ctx.archive, "archive"),
      need(ctx.source, "source"),
    );
    // The zipball is the run's largest allocation and nothing reads it again.
    ctx.archive = undefined;
  },
};

const analyzeScanStage: IngestStage = {
  name: "analyze-scan",
  async run(ctx) {
    const read = need(ctx.read, "read");
    ctx.analyzed = await analyzeSubmittedSkills({
      owner: read.source.owner,
      repo: read.source.repo,
      skills: read.skills,
    });
  },
};

const triageWriteStage: IngestStage = {
  name: "triage-write",
  async run(ctx) {
    const read = need(ctx.read, "read");
    const results: SkillSubmissionSkillResult[] = [];
    ctx.results = results;
    for (const skill of need(ctx.analyzed, "analyzed")) {
      // Each skill's write is atomic and repeatable, so stopping between two of
      // them leaves a consistent catalog for the next run to complete.
      ctx.signal.throwIfAborted();
      results.push(
        await writeSubmittedSkill({
          read,
          userId: ctx.submission.submittedBy,
          skill,
          ...(ctx.deps.compareCommits
            ? { compare: ctx.deps.compareCommits }
            : {}),
          grantTo: {
            teamId: ctx.submission.teamId,
            // A team-scoped import grants the whole team.
            workspaceId:
              ctx.submission.target === "team"
                ? null
                : ctx.submission.workspaceId,
          },
        }),
      );
    }
    // Throws REGISTRY_SUBMISSION_NOT_SKILL when no skill was accepted.
    summarizeSubmission(results, ctx.submission.sourceInput);
    return { results };
  },
};

const onCompleteStage: IngestStage = {
  name: "on-complete",
  optional: true,
  async run(ctx) {
    const install = ctx.submission.onComplete?.install;
    if (!install) {
      return;
    }
    const results = need(ctx.results, "results");
    const accepted = results.filter(
      (item) => item.status !== "failed" && item.slug && item.name,
    );
    // Same matching as `installSkill`'s GitHub path: the author's frontmatter
    // name — what a person says — or the full slug. The whole source was still
    // indexed; only the install narrows.
    const wanted = install.skill?.trim().toLowerCase();
    const selected = wanted
      ? accepted.filter(
          (item) =>
            item.name?.toLowerCase() === wanted ||
            item.slug?.toLowerCase() === wanted,
        )
      : accepted;
    if (wanted && selected.length === 0) {
      // Same code `installSkill` answers with for an unknown `skill`.
      throw new RegistrySubmissionError(
        "SKILL_NOT_FOUND",
        `'${ctx.submission.sourceInput}' has no skill named '${install.skill}'. It ships: ${accepted
          .map((item) => item.name)
          .slice(0, 30)
          .join(", ")}`,
      );
    }

    for (const item of selected) {
      if (item.status !== "indexed") {
        // Held for review: its version is a draft, and installing a draft
        // would be a dead reference.
        item.install = { status: "skipped" };
        continue;
      }
      try {
        const { skills } = await ctx.deps.installSkill({
          teamId: ctx.submission.teamId,
          workspaceId: ctx.submission.workspaceId,
          userId: ctx.submission.submittedBy,
          ref: { kind: "source", source: item.slug! },
          installedVia: install.installedVia ?? "user",
        });
        item.install = {
          status:
            skills[0]?.status === "already_installed"
              ? "already_installed"
              : "installed",
        };
      } catch (error) {
        // The skill IS in the catalog; failing to switch it on here is
        // reported next to it and can be redone from the catalog by hand.
        item.install = { status: "failed", error: describeIngestError(error) };
      }
    }
    return { results };
  },
};

export const GITHUB_INGEST_STAGES: readonly IngestStage[] = Object.freeze([
  resolveStage,
  downloadStage,
  discoverStage,
  analyzeScanStage,
  triageWriteStage,
  onCompleteStage,
]);
