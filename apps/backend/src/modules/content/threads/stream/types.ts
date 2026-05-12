import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ChatInputImage, ThreadToolsSelection } from "../turn/types";

export type RefreshThreadInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  mentionedSourceIds?: string[];
  sourceIds?: string[];
  tools?: ThreadToolsSelection;
  timezone?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  visionProfileAlias?: string | null;
};

export type EditThreadInput = RefreshThreadInput & {
  content: string;
  imagesProvided?: boolean;
  images?: ChatInputImage[];
};
