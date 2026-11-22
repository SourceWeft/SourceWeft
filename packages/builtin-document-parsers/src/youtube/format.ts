/**
 * Renders a YouTube video + its transcript as the markdown stored as the
 * source's content.
 */
import type { YouTubeVideoInfo } from "./catalog/types";
import type { YouTubeTranscript } from "./transcript/types";
import { canonicalVideoUrl, timestampUrl } from "./url";

export const YOUTUBE_SOURCE_MIME_TYPE = "text/x-sourceweft-youtube";

/** `m:ss` under an hour, `h:mm:ss` from an hour on. */
function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Escapes the characters that would end or break markdown link text. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]()]/g, (char) => `\\${char}`);
}

export function formatYouTubeSourceMarkdown(input: {
  video: YouTubeVideoInfo;
  transcript: YouTubeTranscript;
}): string {
  const { video, transcript } = input;

  const headerLines: string[] = [`# ${video.title}`];

  if (video.channelTitle && video.channelUrl) {
    headerLines.push(`Channel: [${escapeLinkText(video.channelTitle)}](${video.channelUrl})`);
  }

  headerLines.push(`Video: ${canonicalVideoUrl(video.videoId)}`);

  headerLines.push(
    `Transcript: AI transcription${transcript.model ? ` (${transcript.model})` : ""}`,
  );

  if (transcript.coverage.kind === "partial") {
    const end = formatTimestamp(transcript.coverage.endSeconds);
    const durationNote =
      transcript.durationSeconds !== undefined
        ? ` of ${formatTimestamp(transcript.durationSeconds)}`
        : "";
    headerLines.push(`Transcript covers 0:00–${end}${durationNote}.`);
  }

  const paragraphs = transcript.segments.map(
    (segment) =>
      `[${formatTimestamp(segment.startSeconds)}](${timestampUrl(video.videoId, segment.startSeconds)}) ${segment.text}`,
  );

  return [headerLines.join("\n"), ...paragraphs].join("\n\n");
}
