import type { MeteredModelCallTrace } from "../../../shared/model-gateway/index";
import type { UsageInfo } from "@sourceweft/model-gateway";
import type { ToolApprovalResume } from "@sourceweft/contracts";
import type { InvocationEvent, InvocationPlan } from "../../invocations/types";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import type { AgentCitation } from "../agent/citation-registry";
import type { ContentBillingPort } from "../../content/billing-port";
import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { ThreadModelKind } from "../model-settings";
import type { TraceContext } from "../../llm-observability";
import { runToolRetrieval } from "../agent/turn/retrieval-runner";
import type { MessageRecord } from "../../content/types";
import type { requireContentWorkspace } from "../../workspace/guards";
import type { findThreadRecord } from "../thread/repository";
import type { resolveActiveChatProfileByAlias } from "./model-resolution";
import type {
  CommandSuccessCriteria,
  ResolvedCommandWorkflow,
  ToolPermission,
} from "./command-registry";
import type { TracePart } from "./trace-parts";

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

/**
 * Per-turn tool settings input: one opaque entry per tool name, plus the few
 * keys the turn pipeline owns itself.
 *
 * Deliberately untyped per capability. Each tool's selection shape is the
 * capability's own vocabulary, and it is the capability's `turnSelection` hook
 * that reads it — listing the shapes here would only let the pipeline reach
 * into a capability it must not know about, and would grow with every new
 * deliverable.
 */
export type ThreadToolsSelection = {
  skillRuntimeConfig?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type TurnOptionsSnapshot = {
  version: 1;
  tools: ThreadToolsSelection;
};

export type PreparedRuntimeTool = {
  toolName: string;
  enabled: boolean;
  permission: ToolPermission;
  shouldBind: boolean;
  selection: Record<string, unknown>;
  options: Record<string, unknown>;
};

export type ConnectorToolSelection = {
  enabled?: boolean;
  connectorId?: string;
};

export type ThreadCommandSelection = {
  name: string;
  arguments?: string;
  kind?: "tool" | "skill";
  displayName?: string;
  skillSlug?: string;
  commandName?: string;
  toolName?: string;
  path?: string;
};

export type ThreadInvocationSelection = {
  selectableId: string;
  userInput: string;
  structuredArgs?: Record<string, unknown>;
};

export type ResolvedThreadInvocation =
  | {
      kind: "fixed_tool_choice";
      selectableId: string;
      target: "capability_tool" | "mcp_tool";
      toolName: string;
      sourceRef: InvocationPlan["sourceRef"];
      userInput: string;
      events: InvocationEvent[];
    }
  | {
      kind: "context_injection";
      selectableId: string;
      sourceRef: InvocationPlan["sourceRef"];
      instruction: string;
      userInput: string;
      events: InvocationEvent[];
    };

export type ResolvedThreadCommand = {
  name: string;
  canonicalName: string;
  arguments: string;
  kind: "tool" | "skill";
  displayName: string;
  toolName?: string;
  title?: string;
  description: string;
  path?: string;
  workflow?: ResolvedCommandWorkflow;
};

/**
 * Pre-`llm`/`image`/`vision` way of naming a profile per model kind, kept for
 * older clients. Written as one entry per model kind rather than a hand-listed
 * pair so the turn pipeline can read whichever kind a tool asks about.
 */
export type LegacyThreadProfileAliasInput = Partial<
  Record<`${ThreadModelKind}ProfileAlias`, string | null>
>;

export type StreamThreadEventInput = LegacyThreadProfileAliasInput & {
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
  invocation?: ThreadInvocationSelection;
  timezone?: string;
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  image?: LlmExecutionConfig;
  vision?: LlmExecutionConfig;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
  agentMode?: "continue" | "replay" | "fork";
  agentBaseCheckpoint?: AgentCheckpointRef | null;
  agentRunThreadId?: string;
  toolApprovalResume?: ToolApprovalResume | null;
  assistantMessageId?: string | null;
  userMessageIdOverride?: string;
  assistantMessageIdOverride?: string;
  existingUserMessage?: MessageRecord;
  contextAnchorUserMessageId?: string | null;
  failurePersistence?: "persist-error-turn" | "transient";
  onPreflightThinkingStep?: (step: ThinkingStepTrace) => void;
  mcpInstallIds?: string[];
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

export type TraceContinuationMetadata = {
  maxSequence: number;
  toolSequenceById: Record<string, number>;
  traceParts?: TracePart[];
  snapshotToolCalls?: ReadonlyArray<{ id: string; sequence?: number | null }>;
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
  webAccessEnabled: boolean;
  command: ResolvedThreadCommand | null;
  invocation: ResolvedThreadInvocation | null;
  commandSuccessCriteria: CommandSuccessCriteria;
  toolPermissions: Record<string, ToolPermission>;
  effectiveTools: ThreadToolsSelection;
  runtimeTools: Record<string, PreparedRuntimeTool>;
  /**
   * What each capability's turn preflight parked for its own tool, keyed by
   * tool name. Opaque here on purpose: the pipeline stores it and the same
   * capability reads it back when the tool is bound. Three capability-shaped
   * fields used to sit in this spot; a fourth deliverable would have added a
   * fourth.
   */
  turnState: Record<string, unknown>;
  timezone: string;
  userMessage: MessageRecord;
  runTraceId: string;
  /** Durable chat-run identity. Set before capability tools are bound. */
  threadRunId?: string;
  createdUserMessage: boolean;
  assistantMessageParentId: string | null;
  assistantMessageId: string | null;
  assistantMessageIdOverride: string | null;
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
  traceContinuation: TraceContinuationMetadata | null;
  isFirstAssistantResponse: boolean;
  isFirstAssistantAttempt: boolean;
  initialTitle: string;
  traceContext?: TraceContext;
  failurePersistence: "persist-error-turn" | "transient";
  mcpInstallIds: string[];
  enabledSkills: EnabledSkillDescriptor[];
  invokedSkillIds: string[];
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

/**
 * A model call settled by the billing scope.
 *
 * Aliases the billing module's trace rather than restating it: the scope is the
 * only producer, so a second near-identical shape here could only drift. The
 * name is kept because it is what the turn outcome and message payloads expose.
 */
export type MeteredLlmCallTrace = MeteredModelCallTrace;

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

export type ToolCallStatus =
  | "running"
  | "approval_requested"
  | "completed"
  | "error";

export type ToolCallTrace = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  status: ToolCallStatus;
  latencyMs: number | null;
  error: string | null;
  sequence: number;
  approvalState?: "approved" | "rejected";
  approvalConfirmationId?: string;
};

export type MessageRenderBlock =
  | {
      id: string;
      placement?: "inline" | "terminal";
      type: "text";
      text: string;
    }
  | {
      durationMs?: number;
      id: string;
      placement?: "inline" | "terminal";
      text: string;
      type: "reasoning";
    }
  | {
      id: string;
      placement?: "inline" | "terminal";
      type: "tool";
      toolCallId: string;
    }
  | {
      artifactId: string;
      artifactVersionId: string;
      id: string;
      placement: "terminal";
      producer: {
        kind: "main" | "subagent";
        subagentType?: string;
      };
      sequence: number;
      sourceToolCallId: string;
      threadRunId: string;
      type: "artifact_output";
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
  retrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null;
  citations: AgentCitation[];
  availableCitations?: AgentCitation[];
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
  meteredLlmCalls?: MeteredLlmCallTrace[];
  thinkingSteps: ThinkingStepTrace[];
  renderBlocks?: MessageRenderBlock[];
  reasoningSegments?: ModelReasoningSegmentTrace[];
  traceParts?: TracePart[];
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
