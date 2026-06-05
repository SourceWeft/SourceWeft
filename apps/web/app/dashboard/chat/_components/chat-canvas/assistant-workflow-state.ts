import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { MessageVersion } from "./types";

export function shouldWorkflowAccordionDefaultOpen(input: {
  blocks: AssistantWorkflowBlock[];
  isRunning: boolean;
  version: MessageVersion;
}) {
  if (input.isRunning) {
    return true;
  }
  return input.blocks.some((block) => {
    if (block.type === "reasoning" || block.type === "text") {
      return false;
    }
    const toolCall = input.version.toolCalls?.find(
      (item) => item.id === block.toolCallId,
    );
    return (
      toolCall?.status === "running" ||
      toolCall?.status === "approval_requested" ||
      toolCall?.status === "error" ||
      toolCall?.approvalState === "rejected"
    );
  });
}
