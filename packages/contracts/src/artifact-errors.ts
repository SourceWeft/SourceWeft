/**
 * One error vocabulary for everything that writes an artifact.
 *
 * Three independent schemes grew up around the write path, each answering the
 * same two questions ("whose fault is it?" and "should the caller try again?")
 * in its own way:
 *
 * | scheme                          | lived in                                        |
 * | ------------------------------- | ----------------------------------------------- |
 * | `ARTIFACT_PUBLISH_ERROR_CODES`  | `builtin-tool-publish-artifact/src/schemas.ts`   |
 * | bare `Error`                    | `builtin-tool-generate-image/src/tool-runtime.ts`|
 * | `DELIVERABLE_JOB_FAILED_CODE`   | `backend/src/worker/deliverable-host/…`          |
 *
 * The codes themselves are a wire contract — clients and stored artifact rows
 * branch on them — so they are NOT renamed here. What is unified is the
 * *classification*: every code maps to exactly one category, and `recoverable`
 * is derived from the category rather than restated per scheme.
 *
 * - `validation`     — the caller supplied something wrong. Changing the input
 *                      and retrying can work, so it is recoverable.
 * - `infrastructure` — a dependency failed. Nothing the caller can change about
 *                      its next call helps; telling an agent otherwise makes it
 *                      retry a dead dependency in a loop and burn the turn.
 * - `conflict`       — someone else already wrote this artifact. The work is
 *                      not lost, but this caller does not own the outcome, so a
 *                      blind retry is wrong.
 *
 * A type-specific code that is not in the table below is reported by the
 * handler that owns it, together with its category; unknown codes fall back to
 * `validation` only when a caller asks for that fallback explicitly.
 */

export const ARTIFACT_ERROR_CATEGORIES = [
  "validation",
  "infrastructure",
  "conflict",
] as const;

export type ArtifactErrorCategory = (typeof ARTIFACT_ERROR_CATEGORIES)[number];

/** Only a caller-fixable fault is worth retrying with a changed input. */
export function isRecoverableArtifactErrorCategory(
  category: ArtifactErrorCategory,
): boolean {
  return category === "validation";
}

/* -------------------------------------------------------------------------- */
/* Canonical codes the shared writer raises                                    */
/* -------------------------------------------------------------------------- */

/**
 * Codes owned by the artifact writer itself. Type-specific codes stay with the
 * capability that produces the type; these are the ones any artifact type can
 * hit because they are about the write, not about the content.
 */
export const ARTIFACT_WRITE_ERROR_CODES = {
  /** The spec failed a handler's `validate`, or a required field was missing. */
  payloadInvalid: "ARTIFACT_PAYLOAD_INVALID",
  /** No write handler claimed the artifactType and the host has no fallback. */
  typeUnsupported: "ARTIFACT_TYPE_UNSUPPORTED",
  /** An attachment carried zero bytes. */
  attachmentEmpty: "ARTIFACT_ATTACHMENT_EMPTY",
  /** An attachment exceeded the limit for its kind. */
  attachmentTooLarge: "ARTIFACT_ATTACHMENT_TOO_LARGE",
  /** Object storage was unreachable or refused the upload. */
  storageUnavailable: "ARTIFACT_STORAGE_UNAVAILABLE",
  /** The artifact row could not be written. */
  recordUnavailable: "ARTIFACT_RECORD_UNAVAILABLE",
  /** The artifact left the expected status before this writer got there. */
  stateConflict: "ARTIFACT_STATE_CONFLICT",
  /** The artifact addressed by a two-phase completion no longer exists. */
  notFound: "ARTIFACT_NOT_FOUND",
} as const;

export type ArtifactWriteErrorCode =
  (typeof ARTIFACT_WRITE_ERROR_CODES)[keyof typeof ARTIFACT_WRITE_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* Classification of every code that predates this module                      */
/* -------------------------------------------------------------------------- */

/**
 * The union of the three existing generic schemes, each assigned its category.
 *
 * The `publish-artifact` rows reproduce `isRecoverableArtifactPublishErrorCode`
 * exactly: the three it called unrecoverable are the three classed
 * `infrastructure` here, everything else is `validation`.
 *
 * Note the surviving divergence, deliberately preserved rather than silently
 * renamed: an empty file publishes as `PPTX_PACKAGE_INVALID` for slides and
 * `ARTIFACT_FILE_EMPTY` for files. Two codes, one situation — the table records
 * that they are the same class, which is as far as a non-breaking change goes.
 */
export const ARTIFACT_ERROR_CATEGORY_BY_CODE: Readonly<
  Record<string, ArtifactErrorCategory>
> = {
  // ── publish-artifact ─────────────────────────────────────────────────────
  PUBLISH_INPUT_INVALID: "validation",
  ARTIFACT_TYPE_UNSUPPORTED: "validation",
  ARTIFACT_SOURCE_UNAVAILABLE: "validation",
  ARTIFACT_SOURCE_NOT_FOUND: "validation",
  ARTIFACT_SOURCE_INVALID: "validation",
  ARTIFACT_STORAGE_UNAVAILABLE: "infrastructure",
  ARTIFACT_RECORD_UNAVAILABLE: "infrastructure",
  ARTIFACT_FILE_EMPTY: "validation",
  ARTIFACT_FILE_TOO_LARGE: "validation",
  ARTIFACT_PREVIEW_IMAGE_INVALID: "validation",
  ARTIFACT_PREVIEW_IMAGE_TOO_LARGE: "validation",
  PPTX_OUTPUT_NOT_FOUND: "validation",
  PPTX_OUTPUT_TOO_LARGE: "validation",
  PPTX_OUTPUT_INVALID_EXTENSION: "validation",
  PPTX_OUTPUT_INVALID_MIME: "validation",
  PPTX_PACKAGE_INVALID: "validation",
  SANDBOX_UNAVAILABLE: "infrastructure",
  PPTX_SOURCE_UNSUPPORTED: "validation",

  // ── writer (this module) ─────────────────────────────────────────────────
  ARTIFACT_PAYLOAD_INVALID: "validation",
  ARTIFACT_ATTACHMENT_EMPTY: "validation",
  ARTIFACT_ATTACHMENT_TOO_LARGE: "validation",
  ARTIFACT_STATE_CONFLICT: "conflict",
  ARTIFACT_NOT_FOUND: "conflict",

  // ── deliverable job boundary ─────────────────────────────────────────────
  DELIVERABLE_JOB_FAILED: "infrastructure",
};

/**
 * Category for a known code. Unknown codes get `fallback`, which defaults to
 * `validation` — the safe direction for an agent-facing surface, since it tells
 * the caller "your input may be fixable" rather than "give up".
 */
export function classifyArtifactErrorCode(
  code: string,
  fallback: ArtifactErrorCategory = "validation",
): ArtifactErrorCategory {
  return ARTIFACT_ERROR_CATEGORY_BY_CODE[code] ?? fallback;
}

export function isRecoverableArtifactErrorCode(code: string): boolean {
  return isRecoverableArtifactErrorCategory(classifyArtifactErrorCode(code));
}

/* -------------------------------------------------------------------------- */
/* The error object                                                            */
/* -------------------------------------------------------------------------- */

export type ArtifactErrorInit = {
  readonly code: string;
  readonly message?: string;
  /** Overrides the table lookup; use when a handler owns a code the host does not know. */
  readonly category?: ArtifactErrorCategory;
  readonly details?: string;
  readonly cause?: unknown;
};

export class ArtifactError extends Error {
  readonly code: string;
  readonly category: ArtifactErrorCategory;
  /** Derived from `category`, never set independently across call sites. */
  readonly recoverable: boolean;
  readonly details?: string;

  constructor(init: ArtifactErrorInit) {
    const details = init.details;
    super(init.message ?? (details ? `${init.code}: ${details}` : init.code));
    this.name = "ArtifactError";
    this.code = init.code;
    this.category = init.category ?? classifyArtifactErrorCode(init.code);
    this.recoverable = isRecoverableArtifactErrorCategory(this.category);
    this.details = details;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/**
 * Structural check, never `instanceof`: capability packages may be loaded from
 * a separate module graph, so an error crossing that boundary is recognized by
 * its shape so errors survive package and worker module boundaries.
 */
export function isArtifactError(error: unknown): error is ArtifactError {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { category?: unknown }).category === "string" &&
    typeof (error as { recoverable?: unknown }).recoverable === "boolean"
  );
}

/**
 * Normalize anything thrown on the write path into the one vocabulary. A bare
 * `Error` (the generate-image scheme) keeps its message and is classified by
 * `fallbackCode` — it never silently becomes "recoverable, code unknown".
 */
export function toArtifactError(
  error: unknown,
  fallbackCode: string = ARTIFACT_WRITE_ERROR_CODES.recordUnavailable,
): ArtifactError {
  if (isArtifactError(error)) {
    return error;
  }
  const carriedCode =
    error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const code = typeof carriedCode === "string" ? carriedCode : fallbackCode;
  return new ArtifactError({
    code,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}
