import type { MessageRenderBlock, ToolCallRecord } from "./types";

export type AssistantAnswerBlock = Extract<MessageRenderBlock, { type: "text" }>;

export type AssistantTerminalBlock = MessageRenderBlock;

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
    }
  | {
      blocks: AssistantTerminalBlock[];
      id: string;
      type: "terminal";
    };

function appendAnswerSegment(
  segments: AssistantRenderSegment[],
  block: AssistantAnswerBlock,
) {
  const last = segments.at(-1);
  if (last?.type === "answer") {
    last.blocks.push(block);
    return;
  }
  segments.push({
    blocks: [block],
    id: `answer-${segments.length + 1}`,
    type: "answer",
  });
}

function appendWorkflowSegment(
  segments: AssistantRenderSegment[],
  block: AssistantWorkflowBlock,
) {
  const last = segments.at(-1);
  if (last?.type === "workflow") {
    last.blocks.push(block);
    return;
  }
  segments.push({
    blocks: [block],
    id: `workflow-${segments.length + 1}`,
    type: "workflow",
  });
}

export function buildAssistantRenderSegments(
  blocks: MessageRenderBlock[],
): AssistantRenderSegment[] {
  const segments: AssistantRenderSegment[] = [];
  const inlineBlocks: MessageRenderBlock[] = [];
  const terminalBlocks: MessageRenderBlock[] = [];

  for (const block of blocks) {
    if (block.placement === "terminal") {
      terminalBlocks.push(block);
      continue;
    }
    inlineBlocks.push(block);
  }

  let lastWorkflowBlockIndex = -1;

  for (let index = inlineBlocks.length - 1; index >= 0; index -= 1) {
    if (inlineBlocks[index]?.type !== "text") {
      lastWorkflowBlockIndex = index;
      break;
    }
  }

  for (const [index, block] of inlineBlocks.entries()) {
    if (block.type === "text" && index > lastWorkflowBlockIndex) {
      appendAnswerSegment(segments, block);
      continue;
    }

    appendWorkflowSegment(segments, block);
  }

  if (terminalBlocks.length > 0) {
    segments.push({
      blocks: terminalBlocks,
      id: `terminal-${segments.length + 1}`,
      type: "terminal",
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
  toolCalls?: ToolCallRecord[];
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
    const latencyMs = input.toolCalls?.find(
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
    return "Working";
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
