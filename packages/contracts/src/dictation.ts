import { z } from "zod";

/**
 * Limits shared by the browser capture code and the backend route. Exact
 * values from the voice dictation design: a segment request that violates
 * any of these is refused before it reaches the model gateway.
 */
export const DICTATION_LIMITS = {
  maxSegmentSeconds: 15,
  maxSegmentBytes: 1024 * 1024,
  requestsPerMinute: 60,
  maxConcurrent: 2,
  maxSilenceSeconds: 60,
  maxSessionSeconds: 600,
} as const;

export const dictationAvailabilityResponseSchema = z.object({
  available: z.boolean(),
});

export const dictationSegmentResponseSchema = z.object({
  text: z.string(),
  durationSec: z.number(),
});

export type DictationAvailabilityResponse = z.infer<
  typeof dictationAvailabilityResponseSchema
>;
export type DictationSegmentResponse = z.infer<
  typeof dictationSegmentResponseSchema
>;

/** Public error codes a dictation segment request can answer with. */
export const DICTATION_ERROR_CODES = {
  /** 404: no transcription route is configured for this deployment. */
  unavailable: "DICTATION_UNAVAILABLE",
  /** 400: the uploaded segment is not a valid WAV file within the limits. */
  invalidAudio: "DICTATION_INVALID_AUDIO",
  /** 402: the team has no credits left to cover the accrued audio. */
  insufficientCredits: "DICTATION_INSUFFICIENT_CREDITS",
  /** 429: too many segment requests for this user. */
  rateLimited: "DICTATION_RATE_LIMITED",
} as const;
