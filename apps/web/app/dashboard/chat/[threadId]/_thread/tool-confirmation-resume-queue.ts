import type { ToolApprovalResume } from "@sourceweft/sdk";
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

export type ToolConfirmationResumeRequest = {
  assistantMessageId: string;
  resolvedConfirmationIds: string[];
  toolApprovalResume: ToolApprovalResume;
};

export function resolveToolConfirmationResumeRequest(input: {
  isStreaming: boolean;
  request: ToolConfirmationResumeRequest;
}) {
  return input.isStreaming
    ? {
        pending: input.request,
        runnable: null,
      }
    : {
        pending: null,
        runnable: input.request,
      };
}

export function flushPendingToolConfirmationResume(input: {
  isStreaming: boolean;
  pending: ToolConfirmationResumeRequest | null;
}) {
  if (input.isStreaming || !input.pending) {
    return {
      pending: input.pending,
      runnable: null,
    };
  }

  return {
    pending: null,
    runnable: input.pending,
  };
}

export function buildToolConfirmationResumeStreamInput(
  input: ToolConfirmationResumeRequest,
): ThreadStreamActionInput {
  return {
    mode: "resume",
    assistantMessageId: input.assistantMessageId,
    attachOnly: true,
    resolvedConfirmationIds: input.resolvedConfirmationIds,
    toolApprovalResume: input.toolApprovalResume,
  };
}
