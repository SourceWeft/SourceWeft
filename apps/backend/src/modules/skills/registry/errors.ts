/**
 * Errors surfaced by the skill-registry submit pipeline
 * (docs/architecture/skill-registry-index.md §3). Mirrors
 * `market/submission.ts`'s `MarketSubmissionError`: a typed `code` the API route
 * maps to a 4xx, keeping the HTTP layer free of pipeline internals.
 */
export class RegistrySubmissionError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RegistrySubmissionError";
    this.code = code;
  }
}
