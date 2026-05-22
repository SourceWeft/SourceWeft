import type { UsageInfo } from "@sourceweft/model-gateway";
import type { ToolApprovalResume } from "@sourceweft/contracts";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import type { AgentCitation } from "../../agent/citation-registry";
import type { ContentBillingPort } from "../../billing-port";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type {
  ArtifactIntentDecision,
  GenerateImageToolSelection,
  ImageModelCapabilities,
} from "../../artifacts/types";
import type { RuntimeModelGatewayProfile } from "../../../../shared/model-gateway/types";
import type { TraceContext } from "../../../../shared/llm-observability";
import { contentRetrievalService } from "../../retrieval/service";
import type { MessageRecord } from "../../types";
import type { requireContentWorkspace } from "../../content-support";
import type { findThreadRecord } from "../thread/repository";
import type { resolveActiveChatProfileByAlias } from "./model-resolution";

export type ChatInputImage = {
  dataUrl: string;
  fileName?: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes?: number;
  width?: number;
  height?: number;
};

export type ChatMessageTextPart = {
  type: "text";
  text: string;
};

export type ChatMessageImagePart = {
  type: "image";
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  storageBucket?: string | null;
  storageKey: string;
  url: string;
  visionDescription?: string;
  visionModelAlias?: string;
  visionProfileAlias?: string;
};

export type MessageContentJson = {
  version: 1;
  parts: Array<ChatMessageTextPart | ChatMessageImagePart>;
};

export type ThreadToolsSelection = {
  skillIds?: string[];
  invokedSkillIds?: string[];
  webSearchEnabled?: boolean;
  artifact?: unknown;
  [AGENT_TOOL_NAMES.generateImage]?: GenerateImageToolSelection;
  [AGENT_TOOL_NAMES.webSearch]?: {
    enabled?: boolean;
  };
  [AGENT_TOOL_NAMES.searchNotionPages]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.createNotionPage]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.appendNotionPage]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.updateNotionPageByTitle]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.deleteNotionPageByTitle]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.saveArtifactToNotion]?: ConnectorToolSelection;
  [AGENT_TOOL_NAMES.saveFinalAnswerToNotion]?: ConnectorToolSelection;
  mcp?: {
    enabled?: boolean;
    installIds?: string[];
    toolIds?: string[];
  };
};

export type ConnectorToolSelection = {
  enabled?: boolean;
  connectorId?: string;
};

export type ThreadCommandSelection = {
  name: string;
  arguments?: string;
  kind?: "tool" | "skill" | "skill-command";
  displayName?: string;
  skillSlug?: string;
  commandName?: string;
  toolName?: string;
  path?: string;
};

export type ResolvedThreadCommand = {
  name: string;
  canonicalName: string;
  arguments: string;
  kind: "tool" | "skill" | "skill-command";
  displayName: string;
  toolName?: string;
  skillSlug: string;
  commandName?: string;
  title?: string;
  description: string;
  path?: string;
  instruction?: string;
  tools?: string[];
  skillSlugs?: string[];
};

export type StreamThreadEventInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  content: string;
  images?: ChatInputImage[];
  existingImageParts?: ChatMessageImagePart[];
  mentionedSourceIds?: string[];
  sourceIds?: string[];
  tools?: ThreadToolsSelection;
  command?: ThreadCommandSelection;
  timezone?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  image?: LlmExecutionConfig;
  vision?: LlmExecutionConfig;
  visionProfileAlias?: string | null;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
  agentMode?: "continue" | "replay" | "fork";
  agentBaseCheckpoint?: AgentCheckpointRef | null;
  agentRunThreadId?: string;
  toolApprovalResume?: ToolApprovalResume | null;
  assistantMessageId?: string | null;
  existingUserMessage?: MessageRecord;
  failurePersistence?: "persist-error-turn" | "transient";
  onPreflightThinkingStep?: (step: ThinkingStepTrace) => void;
};

export type AgentCheckpointRef = {
  threadId: string;
  checkpointId: string;
  checkpointNs?: string;
};

export type AgentCheckpointMetadata = {
  beforeInput: AgentCheckpointRef | null;
  beforeAssistant: AgentCheckpointRef | null;
  resume: AgentCheckpointRef | null;
  final: AgentCheckpointRef | null;
};

export type PreparedThreadTurn = {
  userId: string;
  workspace: Awaited<ReturnType<typeof requireContentWorkspace>>;
  thread: NonNullable<Awaited<ReturnType<typeof findThreadRecord>>>;
  messageContent: string;
  messageContentJson: MessageContentJson;
  imageParts: ChatMessageImagePart[];
  preflightBilling: PreflightBillingTrace[];
  preflightThinkingSteps: ThinkingStepTrace[];
  agentMessageContent: string | AgentMultimodalContentPart[];
  mentionedSourceIds: string[];
  effectiveMentionedSourceIds: string[];
  selectedSourceIds: string[];
  sourceIds: string[];
  sourceScope: {
    requestedSourceIds: string[];
    effectiveSourceIds: string[];
    selectedDirectoryIds: string[];
    expandedDescendantSourceIds: string[];
  };
  skillIds: string[];
  invokedSkillIds: string[];
  selectedSkillIds: string[];
  webSearchEnabled: boolean;
  notionTools: Record<string, ConnectorToolSelection>;
  mcpTools: {
    enabled?: boolean;
    installIds?: string[];
    toolIds?: string[];
  };
  command: ResolvedThreadCommand | null;
  generateImageTool: GenerateImageToolSelection | undefined;
  artifactIntent: ArtifactIntentDecision;
  imageProfile:
    | {
        profile: RuntimeModelGatewayProfile;
        capabilities: ImageModelCapabilities;
      }
    | null;
  timezone: string;
  enabledSkills: EnabledSkillDescriptor[];
  userMessage: MessageRecord;
  runTraceId: string;
  createdUserMessage: boolean;
  assistantMessageParentId: string | null;
  assistantMessageId: string | null;
  profileAlias: string;
  modelAlias: string;
  providerModel: string;
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llm: LlmExecutionConfig | undefined;
  llmIdempotencyKey: string;
  agentMode: "continue" | "replay" | "fork";
  agentBaseCheckpoint: AgentCheckpointRef | null;
  agentRunThreadId: string;
  toolApprovalResume: ToolApprovalResume | null;
  isFirstAssistantResponse: boolean;
  isFirstAssistantAttempt: boolean;
  initialTitle: string;
  traceContext?: TraceContext;
  failurePersistence: "persist-error-turn" | "transient";
};

export type PreflightBillingTrace = {
  id: string;
  operation: string;
  modelKind: string;
  modelAlias: string | null;
  profileAlias: string;
  consumedCredits: number;
  billedBy: "provider_cost" | "minimum_credit" | "skipped";
  skipReason: string | null;
  usage?: UsageInfo;
  metadata?: Record<string, unknown>;
};

export type AgentMultimodalContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

export type RetrievalCallTrace = {
  id: string;
  tool: typeof AGENT_TOOL_NAMES.searchSources;
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

export type MessageRenderBlock =
  | {
      id: string;
      type: "text";
      text: string;
    }
  | {
      id: string;
      type: "generated_image";
      toolCallId: string;
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
  retrieval: Awaited<
    ReturnType<typeof contentRetrievalService.runRetrieval>
  > | null;
  citations: AgentCitation[];
  availableCitations?: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  renderBlocks?: MessageRenderBlock[];
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
  assistantMessageId?: string;
  assistantMetadata?: Record<string, unknown>;
};

export type FinalizeThreadTurnInput = FinalizeThreadTurnCommand & {
  billing: ContentBillingPort;
};
