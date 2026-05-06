import type { UsageInfo } from "@sourceweft/model-gateway";
import type { AgentCitation } from "../../agent/citation-registry";
import type { ContentBillingPort } from "../../billing-port";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { TraceContext } from "../../../../shared/llm-observability";
import { contentRetrievalService } from "../../retrieval/service";
import type { MessageRecord } from "../../types";
import type { requireContentWorkspace } from "../../content-support";
import type { findThreadRecord } from "../thread/repository";
import type { resolveActiveChatProfileByAlias } from "./model-resolution";

export type ThreadToolsSelection = {
  skillIds?: string[];
  webSearchEnabled?: boolean;
};

export type StreamThreadEventInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  content: string;
  sourceIds?: string[];
  tools?: ThreadToolsSelection;
  timezone?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
  agentMode?: "continue" | "replay" | "fork";
  agentBaseCheckpoint?: AgentCheckpointRef | null;
  agentRunThreadId?: string;
  existingUserMessage?: MessageRecord;
  failurePersistence?: "persist-error-turn" | "transient";
};

export type AgentCheckpointRef = {
  threadId: string;
  checkpointId: string;
  checkpointNs?: string;
};

export type AgentCheckpointMetadata = {
  beforeInput: AgentCheckpointRef | null;
  beforeAssistant: AgentCheckpointRef | null;
  final: AgentCheckpointRef | null;
};

export type PreparedThreadTurn = {
  userId: string;
  workspace: Awaited<ReturnType<typeof requireContentWorkspace>>;
  thread: NonNullable<Awaited<ReturnType<typeof findThreadRecord>>>;
  messageContent: string;
  sourceIds: string[];
  skillIds: string[];
  webSearchEnabled: boolean;
  timezone: string;
  enabledSkills: EnabledSkillDescriptor[];
  userMessage: MessageRecord;
  runTraceId: string;
  createdUserMessage: boolean;
  assistantMessageParentId: string | null;
  profileAlias: string;
  modelAlias: string;
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llm: LlmExecutionConfig | undefined;
  llmIdempotencyKey: string;
  agentMode: "continue" | "replay" | "fork";
  agentBaseCheckpoint: AgentCheckpointRef | null;
  agentRunThreadId: string;
  isFirstAssistantResponse: boolean;
  initialTitle: string;
  traceContext?: TraceContext;
  failurePersistence: "persist-error-turn" | "transient";
};

export type RetrievalCallTrace = {
  id: string;
  tool: "search_sources";
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
  kind?: "log" | "state" | "verification" | "reasoning_summary";
  title: string;
  status: "pending" | "in_progress" | "completed";
  items: string[];
  sequence: number;
  description?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
};

export type ModelReasoningSegmentTrace = {
  id: string;
  text: string;
  sequence: number;
  durationMs?: number;
  phase?: "initial" | "after_tool";
  toolCallId?: string;
  tool?: string;
};

export type FinalizeThreadTurnCommand = {
  prepared: PreparedThreadTurn;
  retrieval: Awaited<ReturnType<typeof contentRetrievalService.runRetrieval>> | null;
  citations: AgentCitation[];
  availableCitations?: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  reasoningSegments?: ModelReasoningSegmentTrace[];
  llm?: LlmExecutionConfig;
  operation: "chat.stream" | "chat.complete";
  assistantContent: string;
  usage?: UsageInfo;
  finishReason?: string;
  reasoning?: string;
  routeDecision?: Record<string, unknown>;
  provider?: string | null;
  latencyMs: number;
  modelForMessage?: string | null;
  agentCheckpoint?: AgentCheckpointMetadata;
};

export type FinalizeThreadTurnInput = FinalizeThreadTurnCommand & {
  billing: ContentBillingPort;
};
