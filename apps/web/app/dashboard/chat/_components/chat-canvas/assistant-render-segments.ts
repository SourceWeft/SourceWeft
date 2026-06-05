import type { MessageRenderBlock, MessageVersion } from "./types";

export type AssistantAnswerBlock = Extract<MessageRenderBlock, { type: "text" }>;

export type AssistantWorkflowBlock = MessageRenderBlock;

export type AssistantRenderSegment =
  | {
      blocks: AssistantAnswerBlock[];
      id: string;
      type: "answer";
    }
  | {
      blocks: AssistantWorkflowBlock[];
      id: string;
      type: "workflow";
    };

export function buildAssistantRenderSegments(
  blocks: MessageRenderBlock[],
  options: { includeTrailingTextInWorkflow?: boolean } = {},
): AssistantRenderSegment[] {
  const segments: AssistantRenderSegment[] = [];
  let lastWorkflowBlockIndex = options.includeTrailingTextInWorkflow
    ? blocks.length - 1
    : -1;

  if (!options.includeTrailingTextInWorkflow) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index]?.type !== "text") {
        lastWorkflowBlockIndex = index;
        break;
      }
    }
  }

  for (const [index, block] of blocks.entries()) {
    if (block.type === "text" && index > lastWorkflowBlockIndex) {
      const type = "answer";
      const last = segments.at(-1);
      if (last?.type === "answer") {
        last.blocks.push(block);
        continue;
      }
      segments.push({
        blocks: [block],
        id: `${type}-${segments.length + 1}`,
        type,
      });
      continue;
    }

    const type = "workflow";
    const last = segments.at(-1);
    if (last?.type === "workflow") {
      last.blocks.push(block);
      continue;
    }
    segments.push({
      blocks: [block],
      id: `${type}-${segments.length + 1}`,
      type,
    });
  }

  return segments;
}

export function formatWorkedDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

export function inferWorkflowDurationMs(input: {
  blocks: AssistantWorkflowBlock[];
  version: MessageVersion;
}) {
  const reasoningDurationMs = input.blocks.reduce((sum, block) => {
    if (block.type !== "reasoning") {
      return sum;
    }
    return typeof block.durationMs === "number" && Number.isFinite(block.durationMs)
      ? sum + block.durationMs
      : sum;
  }, 0);
  const toolDurationMs = input.blocks.reduce((sum, block) => {
    if (block.type !== "tool") {
      return sum;
    }
    const latencyMs = input.version.toolCalls?.find(
      (toolCall) => toolCall.id === block.toolCallId,
    )?.latencyMs;
    return typeof latencyMs === "number" && Number.isFinite(latencyMs)
      ? sum + latencyMs
      : sum;
  }, 0);

  return reasoningDurationMs + toolDurationMs;
}

export function getWorkflowHeaderLabel(input: {
  durationMs?: number | null;
  isRunning: boolean;
}) {
  if (input.isRunning) {
    return "Thinking...";
  }

  if (
    typeof input.durationMs !== "number" ||
    !Number.isFinite(input.durationMs) ||
    input.durationMs <= 0
  ) {
    return "Finished working";
  }

  return `Worked for ${formatWorkedDuration(input.durationMs)}`;
}
