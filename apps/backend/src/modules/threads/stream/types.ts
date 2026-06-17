import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { ToolApprovalResume } from "@sourceweft/contracts";
import type {
  ChatInputImage,
  ThreadInvocationSelection,
  ThreadCommandSelection,
  ThreadToolsSelection,
} from "../turn/types";

export type RefreshThreadInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  mentionedSourceIds?: string[];
  sourceIds?: string[];
  tools?: ThreadToolsSelection;
  command?: ThreadCommandSelection;
  invocation?: ThreadInvocationSelection;
  timezone?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  image?: LlmExecutionConfig;
  vision?: LlmExecutionConfig;
  visionProfileAlias?: string | null;
  toolApprovalResume?: ToolApprovalResume | null;
  mcpInstallIds?: string[];
};

export type ResumeThreadInput = RefreshThreadInput & {
  assistantMessageId: string;
  toolApprovalResume: ToolApprovalResume;
};

export type EditThreadInput = RefreshThreadInput & {
  content: string;
  imagesProvided?: boolean;
  images?: ChatInputImage[];
};
