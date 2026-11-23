import {
  YOUTUBE_SOURCE_ERROR_CODES,
  type YouTubeSourceErrorCode,
} from "@sourceweft/contracts/sources";

const CODES: ReadonlySet<string> = new Set(YOUTUBE_SOURCE_ERROR_CODES);

/** The code when it is one of the YouTube codes the UI has words for. */
export function asYouTubeErrorCode(
  code: unknown,
): YouTubeSourceErrorCode | null {
  return typeof code === "string" && CODES.has(code)
    ? (code as YouTubeSourceErrorCode)
    : null;
}

/** The YouTube code a thrown request error carries, if any. */
export function youTubeErrorCodeOf(
  error: unknown,
): YouTubeSourceErrorCode | null {
  return typeof error === "object" && error !== null
    ? asYouTubeErrorCode((error as { code?: unknown }).code)
    : null;
}
