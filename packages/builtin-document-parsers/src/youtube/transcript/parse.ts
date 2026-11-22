/**
 * Parses the plain-text transcript output produced by the Gemini prompt in
 * `gemini.ts` into a header (language/duration/speech) plus timestamped
 * segments.
 *
 * Stamp sanitising: a timestamp that does not strictly increase on the
 * previous accepted one, or that lands more than 5 seconds past the stated
 * duration, is dropped and its text merged into the previous segment (or
 * turned into a segment at 0 if there is no previous segment yet), with a
 * warning recorded either way. Text appearing before the first timestamp is
 * treated as a segment starting at 0.
 */
import type { YouTubeTranscriptSegment } from "./types";

const LANGUAGE_RE = /^LANGUAGE:\s*(.+)$/i;
const DURATION_RE = /^DURATION:\s*(.+)$/i;
const SPEECH_RE = /^SPEECH:\s*(yes|no)\b/i;
const STAMP_RE = /^\[(\d{1,2}(?::\d{2}){1,2})\]\s*(.*)$/;

const TERMINAL_PUNCTUATION_RE = /[.!?。！？"'”’)\]]\s*$/;

function hasTerminalPunctuation(line: string): boolean {
  return TERMINAL_PUNCTUATION_RE.test(line.trimEnd());
}

/** Parses an `M:SS` / `MM:SS` / `H:MM:SS` stamp into seconds. */
function parseStampSeconds(raw: string): number | null {
  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes! * 60 + seconds!;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours! * 3600 + minutes! * 60 + seconds!;
  }
  return null;
}

function dropTruncatedTailLine(lines: string[], text: string): string[] {
  if (lines.length === 0) return lines;
  const lastLine = lines[lines.length - 1] ?? "";
  const endsWithNewline = text.endsWith("\n");
  if (!endsWithNewline || !hasTerminalPunctuation(lastLine)) {
    return lines.slice(0, -1);
  }
  return lines;
}

export function parseTranscriptOutput(
  text: string,
  opts: { truncated: boolean },
): {
  language?: string;
  durationSeconds?: number;
  speech: boolean;
  segments: YouTubeTranscriptSegment[];
  warnings: string[];
} {
  let lines = text.split("\n");
  if (opts.truncated) {
    lines = dropTruncatedTailLine(lines, text);
  }

  let language: string | undefined;
  let durationSeconds: number | undefined;
  let speech = true;
  const warnings: string[] = [];
  const segments: YouTubeTranscriptSegment[] = [];
  let lastAcceptedStamp: number | null = null;
  let sawFirstStamp = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const languageMatch = LANGUAGE_RE.exec(line);
    if (languageMatch) {
      language = languageMatch[1]!.trim();
      continue;
    }

    const durationMatch = DURATION_RE.exec(line);
    if (durationMatch) {
      durationSeconds = parseStampSeconds(durationMatch[1]!.trim()) ?? undefined;
      continue;
    }

    const speechMatch = SPEECH_RE.exec(line);
    if (speechMatch) {
      speech = speechMatch[1]!.toLowerCase() === "yes";
      continue;
    }

    const stampMatch = STAMP_RE.exec(line);
    if (stampMatch) {
      sawFirstStamp = true;
      const stampSeconds = parseStampSeconds(stampMatch[1]!);
      const segmentText = stampMatch[2]!.trim();

      const outOfRange =
        stampSeconds === null ||
        (lastAcceptedStamp !== null && stampSeconds <= lastAcceptedStamp) ||
        (durationSeconds !== undefined && stampSeconds > durationSeconds + 5);

      if (outOfRange) {
        const previous = segments[segments.length - 1];
        if (previous) {
          previous.text = `${previous.text} ${segmentText}`.trim();
        } else {
          segments.push({ startSeconds: 0, text: segmentText });
        }
        warnings.push(
          `Dropped out-of-order or out-of-range timestamp "[${stampMatch[1]}]"; merged its text into the previous segment.`,
        );
        continue;
      }

      segments.push({ startSeconds: stampSeconds, text: segmentText });
      lastAcceptedStamp = stampSeconds;
      continue;
    }

    // A plain text line before the first timestamp becomes (part of) the
    // segment at 0. Stray non-stamp lines after the first timestamp are
    // ignored: the prompt only asks for timestamped lines from then on.
    if (!sawFirstStamp) {
      const previous = segments[segments.length - 1];
      if (previous && previous.startSeconds === 0) {
        previous.text = `${previous.text} ${line}`.trim();
      } else {
        segments.push({ startSeconds: 0, text: line });
      }
    }
  }

  return { language, durationSeconds, speech, segments, warnings };
}
