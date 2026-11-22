/**
 * YouTube transcript provider contracts.
 *
 * `VideoModelPort` is injected by the backend (a later task): it wraps the
 * model gateway call so this package stays free of billing/provider
 * concerns. Tests exercise providers with a fake port that records its
 * input.
 */

export type YouTubeTranscriptSegment = {
  startSeconds: number;
  text: string;
};

export type YouTubeTranscript = {
  language?: string;
  durationSeconds?: number;
  segments: YouTubeTranscriptSegment[];
  coverage: { kind: "complete" } | { kind: "partial"; endSeconds: number };
  origin: "ai_transcription" | "captions";
  providerId: string;
  model?: string;
  warnings: string[];
};

export type VideoModelPort = {
  complete(input: {
    prompt: string;
    videoUrl: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; finishReason?: string; model?: string }>;
};

export interface YouTubeTranscriptProvider {
  readonly id: string;
  transcribe(input: { videoId: string; videoUrl: string }): Promise<YouTubeTranscript>;
}

export const YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS = 65_536;
