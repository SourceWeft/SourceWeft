import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ThreadToolsSelection } from "../turn/types";

export type RefreshThreadInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  sourceIds?: string[];
  tools?: ThreadToolsSelection;
  timezone?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
};

export type EditThreadInput = RefreshThreadInput & {
  content: string;
};
