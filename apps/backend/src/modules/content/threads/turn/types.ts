import type { UsageInfo } from "@sourceweft/model-gateway";
import type { AgentCitation } from "../../agent/citation-registry";
import type { ContentBillingPort } from "../../billing-port";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import { contentRetrievalService } from "../../retrieval/service";
import type { MessageRecord } from "../../types";
import type { requireContentWorkspace } from "../../content-support";
import type { findThreadRecord } from "../thread/repository";
import type { resolveActiveChatProfileByAlias } from "./model-resolution";

export type StreamThreadEventInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  content: string;
  sourceIds?: string[];
  selectedSourceIds?: string[];
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
  agentAssistantMessageParentId?: string | null;
  existingUserMessage?: MessageRecord;
};

export type PreparedThreadTurn = {
  userId: string;
  workspace: Awaited<ReturnType<typeof requireContentWorkspace>>;
  thread: NonNullable<Awaited<ReturnType<typeof findThreadRecord>>>;
  messageContent: string;
  sourceIds: string[];
  selectedSourceIds: string[];
  userMessage: MessageRecord;
  assistantMessageParentId: string | null;
  modelAlias: string;
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llmIdempotencyKey: string;
  deepAgentThreadId: string;
  isFirstAssistantResponse: boolean;
  initialTitle: string;
  firstMessageTitle: string;
};

export type RetrievalCallTrace = {
  id: string;
  tool: "retrieve";
  query: string;
  hitCount: number;
  latencyMs: number;
};

export type ToolCallStatus = "running" | "completed" | "error";

export type ToolCallTrace = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  status: ToolCallStatus;
  latencyMs: number | null;
  error: string | null;
  sequence: number;
};

export type ThinkingStepTrace = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  items: string[];
  sequence: number;
};

export type FinalizeThreadTurnCommand = {
  prepared: PreparedThreadTurn;
  retrieval: Awaited<ReturnType<typeof contentRetrievalService.runRetrieval>> | null;
  citations: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  llm?: LlmExecutionConfig;
  operation: "chat.stream" | "chat.complete";
  assistantContent: string;
  usage?: UsageInfo;
  finishReason?: string;
  reasoning?: string;
  providerFields?: Record<string, unknown>;
  routeDecision?: Record<string, unknown>;
  provider?: string | null;
  providerModel?: string | null;
  latencyMs: number;
  modelForMessage?: string | null;
};

export type FinalizeThreadTurnInput = FinalizeThreadTurnCommand & {
  billing: ContentBillingPort;
};
