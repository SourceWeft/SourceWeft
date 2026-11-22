/**
 * Parses the plain-text transcript output produced by the Gemini prompt in
 * `gemini.ts` into a header (language/duration/speech) plus timestamped
 * segments.
 *
 * Stamp forms recognised: `[H:MM:SS]`, `(H:MM:SS)`, and a bare leading
 * `H:MM:SS` followed by a dash or whitespace (all three also accept the
 * shorter `M:SS`/`MM:SS`). Header keys may be wrapped in markdown bold
 * (`**LANGUAGE:** en`).
 *
 * Stamp sanitising: a timestamp that does not strictly increase on the
 * previous accepted one, or that lands more than 5 seconds past the stated
 * duration, is dropped and its text merged into the previous segment (or
 * turned into a segment at 0 if there is no previous segment yet), with a
 * warning recorded either way. A line that matches none of the recognised
 * stamp forms is never dropped: it is appended to the previous segment's
 * text, or — if there is no segment yet — starts a segment at 0 for text
 * that precedes the first stamp. If that pre-stamp segment at 0 and the
 * first real stamp also land at 0, they are merged into one segment
 * instead of duplicating it. Lines that are only a code fence marker
 * (```` ``` ````) are ignored, and so is any text before the
 * LANGUAGE/DURATION/SPEECH header block when a header appears later in the
 * output (a model preamble such as "Here is the transcript:").
 */
import type { YouTubeTranscriptSegment } from "./types";

const LANGUAGE_RE = /^\*{0,2}LANGUAGE:\*{0,2}\s*(.+)$/i;
const DURATION_RE = /^\*{0,2}DURATION:\*{0,2}\s*(.+)$/i;
const SPEECH_RE = /^\*{0,2}SPEECH:\*{0,2}\s*(yes|no)\b/i;
const CODE_FENCE_RE = /^```/;

const BRACKET_STAMP_RE = /^\[(\d{1,2}(?::\d{2}){1,2})\]\s*(.*)$/;
const PAREN_STAMP_RE = /^\((\d{1,2}(?::\d{2}){1,2})\)\s*(.*)$/;
const BARE_STAMP_RE = /^(\d{1,2}(?::\d{2}){1,2})(?:\s*-\s*|\s+)(.*)$/;

function isHeaderLine(line: string): boolean {
  return LANGUAGE_RE.test(line) || DURATION_RE.test(line) || SPEECH_RE.test(line);
}

function matchStamp(line: string): { stampRaw: string; text: string } | null {
  const bracket = BRACKET_STAMP_RE.exec(line);
  if (bracket) return { stampRaw: bracket[1]!, text: bracket[2]!.trim() };

  const paren = PAREN_STAMP_RE.exec(line);
  if (paren) return { stampRaw: paren[1]!, text: paren[2]!.trim() };

  const bare = BARE_STAMP_RE.exec(line);
  if (bare) return { stampRaw: bare[1]!, text: bare[2]!.trim() };

  return null;
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

/**
 * When the model output was truncated (cut off mid-stream), the raw text's
 * trailing newline is the only signal of whether its last line is whole:
 * if the raw output ends with `\n`, every split line is complete and none
 * is dropped; otherwise the very last line was cut off mid-write and is
 * dropped regardless of how it reads (punctuation is not a signal here —
 * a line can look complete and still have been truncated right after).
 * Trailing blank entries (from extra trailing newlines, or from trailing
 * whitespace with no newline at all) are trimmed first, so the check always
 * targets the actual last content line rather than an empty one.
 */
function dropTruncatedTailLine(lines: string[], rawText: string): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
    end -= 1;
  }
  const trimmed = lines.slice(0, end);
  if (trimmed.length === 0) return trimmed;

  return rawText.endsWith("\n") ? trimmed : trimmed.slice(0, -1);
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

  // Any header line's index, so lines before it (a model preamble) can be
  // dropped. -1 when there is no header anywhere, in which case nothing is
  // treated as preamble.
  const headerLineIndex = lines.findIndex((rawLine) => {
    const line = rawLine.trim();
    return line.length > 0 && isHeaderLine(line);
  });

  let language: string | undefined;
  let durationSeconds: number | undefined;
  let speech = true;
  const warnings: string[] = [];
  const segments: YouTubeTranscriptSegment[] = [];
  let lastAcceptedStamp: number | null = null;
  let sawFirstStamp = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) continue;

    if (headerLineIndex >= 0 && index < headerLineIndex) {
      // A model preamble ("Here is the transcript:") before the header
      // block is never real transcript content.
      continue;
    }

    if (CODE_FENCE_RE.test(line)) {
      // The model sometimes wraps its answer in a code fence; the fence
      // markers themselves are structural, never transcript content.
      continue;
    }

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

    const stamp = matchStamp(line);
    if (stamp) {
      const stampSeconds = parseStampSeconds(stamp.stampRaw);

      const outOfRange =
        stampSeconds === null ||
        (lastAcceptedStamp !== null && stampSeconds <= lastAcceptedStamp) ||
        (durationSeconds !== undefined && stampSeconds > durationSeconds + 5);

      if (outOfRange) {
        const previous = segments[segments.length - 1];
        if (previous) {
          previous.text = `${previous.text} ${stamp.text}`.trim();
        } else {
          segments.push({ startSeconds: 0, text: stamp.text });
        }
        warnings.push(
          `Dropped out-of-order or out-of-range timestamp "${stamp.stampRaw}"; merged its text into the previous segment.`,
        );
        continue;
      }

      if (!sawFirstStamp && stampSeconds === 0) {
        // Text before the first stamp already created a segment at 0; if
        // the first real stamp also lands at 0, merge into it instead of
        // duplicating segment 0.
        const previous = segments[segments.length - 1];
        if (previous && previous.startSeconds === 0) {
          previous.text = `${previous.text} ${stamp.text}`.trim();
          lastAcceptedStamp = 0;
          sawFirstStamp = true;
          continue;
        }
      }

      segments.push({ startSeconds: stampSeconds, text: stamp.text });
      lastAcceptedStamp = stampSeconds;
      sawFirstStamp = true;
      continue;
    }

    // Any other non-empty line is real content that must never be
    // dropped: continue the previous segment, or — before the first
    // stamp — start the segment at 0.
    const previous = segments[segments.length - 1];
    if (previous) {
      previous.text = `${previous.text} ${line}`.trim();
    } else {
      segments.push({ startSeconds: 0, text: line });
    }
  }

  return { language, durationSeconds, speech, segments, warnings };
}
