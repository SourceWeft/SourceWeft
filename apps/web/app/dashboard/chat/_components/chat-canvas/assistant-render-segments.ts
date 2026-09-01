import type { MessageRenderBlock } from "./types";

export type AssistantAnswerBlock = Extract<
  MessageRenderBlock,
  { type: "text" }
>;

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

  for (const block of inlineBlocks) {
    if (block.type === "text") {
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
