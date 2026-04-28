import type { LlmExecutionConfig } from "../../model-gateway-audit";

export type RefreshThreadInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  sourceIds?: string[];
  selectedSourceIds?: string[];
  userMessageId?: string;
  assistantMessageId?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
};

export type EditThreadInput = RefreshThreadInput & {
  content: string;
};
