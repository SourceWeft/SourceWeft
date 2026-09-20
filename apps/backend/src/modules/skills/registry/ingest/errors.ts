import { isContentError } from "../../../content/errors";
import { GitHubArchiveError } from "../../../market/parser/github-zip";
import { SkillParseError } from "../../frontmatter";
import { RegistrySubmissionError } from "../errors";
import { mapRegistryArchiveError } from "../read";

/**
 * Failure taxonomy of an ingest run: what the submission row records, and
 * whether running the job again could end differently.
 */

/** The job's overall deadline fired; the run already spent its whole budget. */
export const INGEST_DEADLINE_CODE = "REGISTRY_SUBMISSION_DEADLINE";
/** Fallback for an error that carries no code of its own. */
export const INGEST_FAILED_CODE = "REGISTRY_SUBMISSION_FAILED";

/**
 * This run no longer owns the submission: its claim was taken over by a
 * redelivered job, or the row was closed from outside. It must stop without
 * recording anything — the row belongs to someone else now.
 */
export class IngestSupersededError extends Error {
  constructor(submissionId: string) {
    super(`Skill submission ${submissionId} is no longer owned by this run`);
    this.name = "IngestSupersededError";
  }
}

// `downloadRepoZip` reports a non-2xx as ARCHIVE_UNAVAILABLE with the status at
// the end of the message. A 429/5xx there is GitHub having a bad moment (and
// `githubFetch` already exhausted its own short retries); a 404 is an answer.
const UPSTREAM_STATUS_PATTERN = /\b(429|5\d\d)\b/;

/**
 * Whether a later attempt could succeed. Deterministic failures — not a skill,
 * too large, unpinnable, an ownership conflict, a parse error — say something
 * about the SOURCE and would fail identically every time, so retrying them only
 * delays the answer. Everything that is not recognisably deterministic (a
 * dropped connection, `fetch failed`, a database hiccup) is worth another go.
 */
export function isTransientIngestError(error: unknown): boolean {
  if (error instanceof IngestSupersededError) {
    return false;
  }
  if (error instanceof GitHubArchiveError) {
    return (
      error.code === "ARCHIVE_TIMEOUT" ||
      (error.code === "ARCHIVE_UNAVAILABLE" &&
        UPSTREAM_STATUS_PATTERN.test(error.message))
    );
  }
  if (error instanceof RegistrySubmissionError) {
    return (
      error.code === "REGISTRY_SUBMISSION_TIMEOUT" ||
      // The date exists for every commit; only GitHub's metadata read failed.
      error.code === "REGISTRY_SUBMISSION_UNDATED"
    );
  }
  if (error instanceof SkillParseError || isContentError(error)) {
    return false;
  }
  return true;
}

/** The `{ code, message }` a failed stage / submission records. */
export function describeIngestError(error: unknown): {
  code: string;
  message: string;
} {
  const mapped = mapRegistryArchiveError(error);
  if (
    mapped instanceof RegistrySubmissionError ||
    mapped instanceof SkillParseError ||
    isContentError(mapped)
  ) {
    return { code: mapped.code, message: mapped.message };
  }
  return {
    code: INGEST_FAILED_CODE,
    message: mapped instanceof Error ? mapped.message : String(mapped),
  };
}
