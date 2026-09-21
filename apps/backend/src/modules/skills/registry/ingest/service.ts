import type { SkillSubmissionOptions } from "@sourceweft/db";
import type { SkillSubmission } from "@sourceweft/contracts";
import { logger } from "../../../../shared/logger";
import { ContentError } from "../../../content/errors";
import { isMarketAdmin } from "../../../market/admin";
import { normalizeGitHubSource } from "../../../market/parser/github";
import { enqueueSkillIngestJob } from "./queue";
import {
  createOrReuseSubmission,
  failSubmissionIfInFlight,
  getSubmission,
  listSubmissions,
  requeueFailedSubmission,
  type SkillSubmissionRow,
} from "./repository";

/**
 * API-side half of the asynchronous skill ingest: create a submission and hand
 * it to the queue, then let the submitter watch it. The work itself happens in
 * the worker (`pipeline.ts`); nothing here talks to GitHub.
 */

export const SKILL_SUBMISSION_PAGE_LIMITS = Object.freeze({
  default: 20,
  max: 100,
});

const ENQUEUE_FAILED_CODE = "SKILL_SUBMISSION_ENQUEUE_FAILED";

type Viewer = { teamId: string; workspaceId: string; userId: string };

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function mapSkillSubmission(row: SkillSubmissionRow): SkillSubmission {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    submittedBy: row.submittedBy,
    sourceKind: row.sourceKind,
    sourceInput: row.sourceInput,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    ref: row.ref,
    subpath: row.subpath,
    commitSha: row.commitSha,
    commitCommittedAt: iso(row.commitCommittedAt),
    target: row.target,
    status: row.status,
    stage: row.stage,
    // jsonb hands the keys back in its own order; restore execution order so a
    // client can render the stages as they come.
    stages: Object.fromEntries(
      Object.entries(row.stages).sort(([, a], [, b]) =>
        a.startedAt.localeCompare(b.startedAt),
      ),
    ),
    results: row.results,
    onComplete: row.onComplete,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

type SubmissionCursor = { createdAt: Date; id: string };

function encodeCursor(row: SkillSubmissionRow): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }),
  ).toString("base64url");
}

/** Null for anything that is not a cursor this module issued. */
export function decodeSkillSubmissionCursor(
  cursor: string,
): SubmissionCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    const createdAt = new Date(parsed.c);
    return Number.isNaN(createdAt.getTime()) || !parsed.i
      ? null
      : { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/**
 * A row that never reached the queue would sit `queued` forever with nothing
 * behind it, and would block the submitter from trying the same source again.
 */
async function enqueueOrFail(row: SkillSubmissionRow) {
  try {
    await enqueueSkillIngestJob(row);
  } catch (error) {
    logger.error("Skill ingest enqueue failed", {
      submissionId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await failSubmissionIfInFlight(row.id, {
      code: ENQUEUE_FAILED_CODE,
      message: "The import could not be queued. Try again in a moment.",
    });
    throw new ContentError(
      503,
      ENQUEUE_FAILED_CODE,
      "The import could not be queued. Try again in a moment.",
      { recoverable: true },
    );
  }
}

export async function createSkillSubmission(
  input: Viewer & {
    source: string;
    install?: { skill?: string; installedVia?: "user" | "agent" };
    /** Only the platform's own import passes these (`system-submit.ts`). */
    options?: SkillSubmissionOptions;
  },
): Promise<{ submission: SkillSubmission; created: boolean }> {
  const sourceInput = input.source.trim();
  // Cheap, offline validation so garbage is refused here rather than becoming
  // a failed job. Whether the repository exists is the worker's to find out.
  let source: ReturnType<typeof normalizeGitHubSource>;
  try {
    source = normalizeGitHubSource(sourceInput);
  } catch (error) {
    throw new ContentError(
      422,
      "REGISTRY_SUBMISSION_INVALID_SOURCE",
      error instanceof Error ? error.message : "Unsupported GitHub source",
    );
  }

  const { submission, created } = await createOrReuseSubmission({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    submittedBy: input.userId,
    sourceInput,
    repoOwner: source.owner,
    repoName: source.repo,
    ref: source.ref ?? null,
    subpath: source.subpath || null,
    onComplete: input.install
      ? {
          install: {
            ...(input.install.skill ? { skill: input.install.skill } : {}),
            ...(input.install.installedVia
              ? { installedVia: input.install.installedVia }
              : {}),
          },
        }
      : null,
    ...(input.options ? { options: input.options } : {}),
  });
  if (created) {
    await enqueueOrFail(submission);
  }
  return { submission: mapSkillSubmission(submission), created };
}

export async function listSkillSubmissions(
  input: Viewer & { limit: number; cursor?: SubmissionCursor },
): Promise<{ items: SkillSubmission[]; nextCursor: string | null }> {
  // One extra row tells whether another page exists without a count query.
  const rows = await listSubmissions({
    workspaceId: input.workspaceId,
    submittedBy: input.userId,
    limit: input.limit + 1,
    before: input.cursor,
  });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapSkillSubmission),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
}

/**
 * A submission is visible to whoever made it, inside the workspace it was made
 * in — and to market admins, who field "my import failed" reports. Everything
 * else is a plain 404, so ids cannot be probed.
 */
async function requireVisibleSubmission(
  input: Viewer & { submissionId: string },
): Promise<SkillSubmissionRow> {
  const row = await getSubmission(input.submissionId);
  if (
    !row ||
    row.workspaceId !== input.workspaceId ||
    (row.submittedBy !== input.userId && !isMarketAdmin(input.userId))
  ) {
    throw new ContentError(
      404,
      "SKILL_SUBMISSION_NOT_FOUND",
      "Skill submission not found",
    );
  }
  return row;
}

export async function getSkillSubmission(
  input: Viewer & { submissionId: string },
): Promise<{ submission: SkillSubmission }> {
  return { submission: mapSkillSubmission(await requireVisibleSubmission(input)) };
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function retrySkillSubmission(
  input: Viewer & { submissionId: string },
): Promise<{ submission: SkillSubmission }> {
  const row = await requireVisibleSubmission(input);
  const notFailed = () =>
    new ContentError(
      409,
      "SKILL_SUBMISSION_NOT_RETRYABLE",
      "Only a failed import can be retried",
    );
  if (row.status !== "failed") {
    throw notFailed();
  }

  let requeued: SkillSubmissionRow | null;
  try {
    requeued = await requeueFailedSubmission(row.id);
  } catch (error) {
    // The in-flight slot for this source is taken: the submitter started a new
    // import of it after this one failed.
    if (isUniqueViolation(error)) {
      throw new ContentError(
        409,
        "SKILL_SUBMISSION_IN_FLIGHT",
        "Another import of this source is already in progress",
      );
    }
    throw error;
  }
  // Lost a race with a concurrent retry of the same submission.
  if (!requeued) {
    throw notFailed();
  }
  await enqueueOrFail(requeued);
  return { submission: mapSkillSubmission(requeued) };
}
