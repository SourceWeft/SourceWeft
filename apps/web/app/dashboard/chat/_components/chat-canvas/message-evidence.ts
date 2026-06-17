import { stripGeneratedImageMarkdown } from "./message-assets";
import type { AssistantRenderSegment } from "./assistant-render-segments";
import type { CitationRecord, ToolCallRecord } from "./types";

export function shouldShowPossibleEvidence(input: {
  availableCitations?: CitationRecord[];
  citations?: CitationRecord[];
  hasInlineCitationMarkers: boolean;
  showLoading: boolean;
}) {
  return (
    !input.showLoading &&
    !input.hasInlineCitationMarkers &&
    (input.citations?.length ?? 0) === 0 &&
    (input.availableCitations?.length ?? 0) > 0
  );
}

export function findLastAnswerSegmentId(input: {
  segments: AssistantRenderSegment[];
  toolCalls?: ToolCallRecord[];
  workspaceId?: string | null;
}) {
  for (let index = input.segments.length - 1; index >= 0; index -= 1) {
    const segment = input.segments[index];
    if (segment?.type !== "answer") {
      continue;
    }
    const blockText = stripGeneratedImageMarkdown({
      content: segment.blocks.map((block) => block.text).join(""),
      toolCalls: input.toolCalls,
      trim: false,
      workspaceId: input.workspaceId,
    });
    if (blockText.length > 0) {
      return segment.id;
    }
  }
  return null;
}
