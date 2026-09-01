import type { MessageRenderState } from "./message-render-state";

type RunErrorRenderState = Pick<MessageRenderState, "error" | "activityItems">;

function normalizeErrorText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * A failed tool card already renders its own error text (failed tool cards
 * auto-open), so the run-level "Message failed" banner would just repeat it.
 * Detect that overlap so the same failure is shown exactly once.
 */
export function isRunErrorCoveredByToolCard(
  renderState: RunErrorRenderState,
): boolean {
  const runMessage = normalizeErrorText(renderState.error?.message);
  if (!runMessage) {
    return false;
  }
  return renderState.activityItems.some((item) => {
    if (item.type !== "tool") {
      return false;
    }
    // Match on a populated tool error rather than status: a failed *deliverable*
    // tool surfaces its failure through the deliverable pipeline (status stays
    // "completed") yet still carries the same message on `toolCall.error`.
    const toolMessage = normalizeErrorText(item.toolCall.error);
    if (!toolMessage) {
      return false;
    }
    return (
      toolMessage === runMessage ||
      toolMessage.includes(runMessage) ||
      runMessage.includes(toolMessage)
    );
  });
}

/**
 * Decides whether to render the run-level assistant error banner.
 *
 * The banner must never render off a *stale* errored version:
 *  - while this version is streaming/live, or
 *  - while an in-flight run is about to supersede it (retry / regenerate),
 * which is the transient "red flash before content shows".
 *
 * It is also suppressed when a failed tool card already surfaces the same
 * error, so one failure is not shown red twice.
 */
export function shouldShowRunErrorBanner(input: {
  hasActiveRunOnThisGroup: boolean;
  isStreamingThisVersion: boolean;
  renderState: RunErrorRenderState;
}): boolean {
  const { hasActiveRunOnThisGroup, isStreamingThisVersion, renderState } =
    input;
  if (!renderState.error) {
    return false;
  }
  if (isStreamingThisVersion || hasActiveRunOnThisGroup) {
    return false;
  }
  if (isRunErrorCoveredByToolCard(renderState)) {
    return false;
  }
  return true;
}
