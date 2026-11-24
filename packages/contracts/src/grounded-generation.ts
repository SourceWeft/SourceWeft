import { z } from "zod";

/**
 * Ports and errors shared by every generator that grounds its output in
 * source chunks. They are types plus one pure error class, so nothing here
 * pulls server code into a browser graph. Artifact-specific contracts (study,
 * data tables) bind `Op` and the checkpoint shape and re-export under their
 * own names.
 */

/* ------------------------------------------------------------------ errors */

export const groundedErrorCodeSchema = z.enum([
  "INSUFFICIENT_CREDITS",
  "INPUT_TOO_LARGE",
  "NO_INDEXED_SOURCES",
  "MODEL_UNAVAILABLE",
  "GENERATION_QUALITY_TOO_LOW",
  "SOURCE_NOT_READABLE",
]);
export type GroundedErrorCode = z.infer<typeof groundedErrorCodeSchema>;

/** A generation failure with the code the artifact records. */
export class GroundedGenerationError extends Error {
  readonly code: GroundedErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: GroundedErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GroundedGenerationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Structural check, never `instanceof` alone: the capability's module graph
 * and the host's may hold separate copies of this class. The legacy name
 * `StudyGenerationError` is accepted too, because during a rolling deploy an
 * older instance may still raise it.
 */
export function isGroundedGenerationError(
  error: unknown,
): error is GroundedGenerationError {
  if (error instanceof GroundedGenerationError) return true;
  return (
    error instanceof Error &&
    (error.name === "GroundedGenerationError" ||
      error.name === "StudyGenerationError") &&
    groundedErrorCodeSchema.safeParse((error as { code?: unknown }).code).success
  );
}

/**
 * A model call that timed out on every target of the route. Unlike a
 * `GroundedGenerationError` it does not end the job: the same request usually
 * succeeds when sent again, so a generator may retry it once.
 */
export class GroundedModelTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GroundedModelTimeoutError";
  }
}

/** Structural, like `isGroundedGenerationError`: module copies share the name. */
export function isGroundedModelTimeout(error: unknown): error is GroundedModelTimeoutError {
  return error instanceof Error && error.name === "GroundedModelTimeoutError";
}

/**
 * Lower-cases, folds width/compatibility forms, drops punctuation and spaces.
 * The text normalization behind every artifact type's fingerprints, so that
 * incidental edits (case, spacing, punctuation) keep an item's identity.
 */
export function normalizeFingerprintText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

/* ------------------------------------------------------------------- ports */

/** One structured-output call on the default chat model, billed by the host. */
export interface GroundedModelPort<Op extends string = string> {
  /**
   * The host never substitutes another model: an unusable default fails with
   * `MODEL_UNAVAILABLE`, refused admission with `INSUFFICIENT_CREDITS` (both as
   * `GroundedGenerationError`), a call that timed out on every target as
   * `GroundedModelTimeoutError`. Other failures are thrown as they are.
   */
  completeStructured(input: {
    operation: Op;
    idempotencyKey: string;
    referenceId: string;
    system: string;
    user: string;
    schema: { name: string; description: string; schema: Record<string, unknown> };
    maxTokens: number;
  }): Promise<unknown>;
}

export type GroundedAnchorRequest = {
  /** The generated text that should be supported by the chunk. */
  text: string;
  chunkId: string;
  chunkContent: string;
};

export type GroundedAnchorResult = {
  /** Range inside `chunkContent`. */
  startChar: number;
  endChar: number;
  quote: string;
  /** 0..1 */
  confidence: number;
};

/** Finds where generated text is supported in its cited chunk. */
export interface GroundedAnchorPort {
  /** One result per request, in order; null when the chunk does not support it. */
  anchor(
    requests: readonly GroundedAnchorRequest[],
  ): Promise<(GroundedAnchorResult | null)[]>;
}

/**
 * The engine's resume state, stored by the host as JSON and handed back
 * unchanged. The checkpoint shape belongs to the artifact type.
 */
export interface GroundedCheckpointStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

/** A chunk as the host loads it. */
export type GroundedCorpusChunk = {
  chunkId: string;
  sourceId: string;
  documentId: string;
  chunkNo: number;
  headingPath: string | null;
  language: string | null;
  text: string;
};
