/**
 * Bounds for reasoning text persisted for a chat run: the run snapshot the
 * durable runner flushes, and the assistant message every terminal writer
 * (finalizer, stream error message, durable failure) projects.
 *
 * A Thinking-on run streams one `reasoning` delta per token for every model
 * call; the stream guards cap one call, these caps bound what a whole run
 * (about ninety steps) accumulates. Both keep the tail: the newest reasoning
 * is what a reloaded client needs to show where the run currently is.
 *
 * Every writer must bound through the same helpers. The reasoningWrite CAS
 * (`turn/reasoning-state.ts`) accepts a write at an equal revision only when
 * the projected text is identical, so a terminal writer projecting the
 * unbounded runtime text and a later snapshot-derived writer projecting the
 * bounded text would silently drop the second write.
 */

/** Longest text kept for one reasoning render block (one model call). */
export const MAX_REASONING_SEGMENT_CHARS = 64_000;

/** Longest accumulated `reasoning` kept across all segments of one run. */
export const MAX_SNAPSHOT_REASONING_CHARS = 256_000;

// Distinctive on purpose: `shared/safe-error-text.ts` emits the plain
// `…[truncated N chars]` literal for tool output, which a model can echo at
// the start of its reasoning; that must parse as ordinary text, not as a
// prior marker of ours.
const MARKER_PATTERN = /^…\[reasoning truncated: (\d+) chars dropped\]/u;

function truncationMarker(droppedChars: number) {
  return `…[reasoning truncated: ${droppedChars} chars dropped]`;
}

/**
 * Keep the tail of `text` so the result is at most `limit` characters, with
 * an inline `…[reasoning truncated: N chars dropped]` prefix counting every
 * character dropped so far. Pure and idempotent: feeding an already-bounded
 * text (marker included) back in keeps the cumulative count instead of
 * restarting it, so bounding once on the full text and re-bounding after each
 * appended delta produce the same string for the same input sequence.
 *
 * A `limit` too small to hold the marker returns the marker cut to `limit`:
 * the truncation stays visible and the length bound still holds. Production
 * limits are tens of thousands of characters; this only matters for tests.
 */
export function boundReasoningText(text: string, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("Reasoning bound limit must be a positive number");
  }
  if (text.length <= limit) {
    return text;
  }

  const previous = MARKER_PATTERN.exec(text);
  const previouslyDropped = previous ? Number(previous[1]) : 0;
  const body = previous ? text.slice(previous[0].length) : text;

  // Choose the smallest cut that fits the marker and the kept tail into the
  // limit. The marker's width depends on the count, so settle it by iteration;
  // the count grows by one digit at most a few times.
  let cut = Math.max(0, body.length - limit);
  while (
    cut < body.length &&
    truncationMarker(previouslyDropped + cut).length + body.length - cut > limit
  ) {
    cut += 1;
  }

  const marker = truncationMarker(previouslyDropped + cut);
  if (marker.length >= limit) {
    return marker.slice(0, limit);
  }
  return `${marker}${body.slice(cut)}`;
}

/** The one bounding rule for a reasoning segment's text (one render block). */
export function boundReasoningSegmentText(text: string): string {
  return boundReasoningText(text, MAX_REASONING_SEGMENT_CHARS);
}

/** The one bounding rule for a run's accumulated `reasoning` text. */
export function boundSnapshotReasoning(text: string): string;
export function boundSnapshotReasoning(
  text: string | undefined,
): string | undefined;
export function boundSnapshotReasoning(text: string | undefined) {
  return typeof text === "string"
    ? boundReasoningText(text, MAX_SNAPSHOT_REASONING_CHARS)
    : text;
}

/**
 * Apply the segment bound to every reasoning render block in place of its
 * text, leaving other blocks and already-bounded blocks untouched (same
 * object), so the snapshot path and the terminal writers persist identical
 * block text for the same streamed segment.
 */
export function boundReasoningRenderBlocks<T>(blocks: T[]): T[];
export function boundReasoningRenderBlocks<T>(
  blocks: T[] | undefined,
): T[] | undefined;
export function boundReasoningRenderBlocks<T>(blocks: T[] | undefined) {
  if (!blocks) {
    return blocks;
  }
  return blocks.map((block) => {
    const record =
      block && typeof block === "object" && !Array.isArray(block)
        ? (block as { type?: unknown; text?: unknown })
        : null;
    if (
      !record ||
      record.type !== "reasoning" ||
      typeof record.text !== "string"
    ) {
      return block;
    }
    const text = boundReasoningSegmentText(record.text);
    return text === record.text ? block : ({ ...record, text } as T);
  });
}
