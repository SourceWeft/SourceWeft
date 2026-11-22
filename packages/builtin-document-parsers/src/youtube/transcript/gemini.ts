/**
 * `gemini` YouTube transcript provider.
 *
 * Asks the injected `VideoModelPort` (the model gateway, wired up by the
 * backend) to transcribe a public YouTube video verbatim as plain text in a
 * fixed `LANGUAGE:`/`DURATION:`/`SPEECH:` header plus `[H:MM:SS] text`
 * lines, then hands the raw text to `parseTranscriptOutput`.
 */
import { YouTubeSourceError } from "../errors";
import { parseTranscriptOutput } from "./parse";
import {
  YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS,
  type VideoModelPort,
  type YouTubeTranscript,
  type YouTubeTranscriptProvider,
} from "./types";

export const GEMINI_TRANSCRIPT_PROMPT = `Transcribe the speech in this video verbatim, in the language that is spoken. Do not translate, summarise or skip anything.
Answer in plain text exactly in this format:
LANGUAGE: <BCP-47 code of the main spoken language>
DURATION: <length of the video as H:MM:SS>
SPEECH: <yes if the video contains speech, otherwise no>
[H:MM:SS] <what is said from this moment>
Start a new timestamped line at least every 30 seconds and whenever the speaker or topic changes. Timestamps are the start time of the line and must increase.`;

/**
 * Only a `"stop"` finish (or a provider that reports none) is a model that
 * ended on its own. `length`, `content_filter`, `error` or anything else
 * means the output may stop mid-line, so it is treated as truncated.
 */
function isTruncatedFinish(finishReason: string | undefined): boolean {
  return finishReason !== undefined && finishReason !== "stop";
}

export function createGeminiTranscriptProvider(deps: {
  model: VideoModelPort;
}): YouTubeTranscriptProvider {
  return {
    id: "gemini",

    async transcribe(input: { videoId: string; videoUrl: string }): Promise<YouTubeTranscript> {
      const result = await deps.model.complete({
        prompt: GEMINI_TRANSCRIPT_PROMPT,
        videoUrl: input.videoUrl,
        maxOutputTokens: YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS,
      });

      const text = result.text ?? "";
      if (!text.trim()) {
        throw new YouTubeSourceError(
          502,
          "YOUTUBE_TRANSCRIPT_FAILED",
          "The transcription model returned no output",
        );
      }

      const truncated = isTruncatedFinish(result.finishReason);
      const parsed = parseTranscriptOutput(text, { truncated });

      // The model saying there is no speech wins over truncation: a
      // `SPEECH: no` answer cut short is still "no speech".
      if (!parsed.speech) {
        throw new YouTubeSourceError(
          422,
          "YOUTUBE_NO_SPEECH",
          "This video does not appear to contain speech to transcribe",
        );
      }

      if (parsed.segments.length === 0) {
        // Truncation (not a lack of speech) is why there is nothing to
        // show: the one usable line, if any, was cut off mid-write and
        // dropped. That is a failed call, not "no speech".
        if (truncated) {
          throw new YouTubeSourceError(
            502,
            "YOUTUBE_TRANSCRIPT_FAILED",
            "The transcription was truncated before any usable line was produced",
          );
        }
        throw new YouTubeSourceError(
          422,
          "YOUTUBE_NO_SPEECH",
          "This video does not appear to contain speech to transcribe",
        );
      }

      const coverage: YouTubeTranscript["coverage"] = truncated
        ? {
            kind: "partial",
            endSeconds: parsed.segments[parsed.segments.length - 1]!.startSeconds,
          }
        : { kind: "complete" };

      return {
        language: parsed.language,
        durationSeconds: parsed.durationSeconds,
        segments: parsed.segments,
        coverage,
        origin: "ai_transcription",
        providerId: "gemini",
        model: result.model,
        ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
        warnings: parsed.warnings,
      };
    },
  };
}
