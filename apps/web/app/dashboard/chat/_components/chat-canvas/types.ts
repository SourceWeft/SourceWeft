import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type ChatInputImage,
  type ChatMessageImagePart,
  type ToolApprovalResume,
  type SkillCommand,
  type ThreadCommandRequest,
  type McpToolSelection,
} from "@sourceweft/sdk";

export type { ChatMessageImagePart };

export type ChatSendInput = {
  content: string;
  skillIds?: string[];
  images?: ChatInputImage[];
  mentionedSourceIds?: string[];
  tools?: ChatToolsSelection;
  command?: ThreadCommandRequest;
};

export type ToolConfirmationInterventionSignal = {
  id: string;
};

export type ToolConfirmationResolution = {
  confirmationId: string;
  decision: "approve" | "reject";
  resume?: ToolApprovalResume | null;
  expired?: boolean;
  stale?: boolean;
  stopped?: boolean;
};

export type MessageVersion = {
  id: string;
  renderKey?: string;
  content: string;
  contentJson?: Record<string, unknown>;
  command?: ThreadCommandRequest;
  citations?: CitationRecord[];
  availableCitations?: CitationRecord[];
  isError?: boolean;
  isCancelled?: boolean;
  error?: string | null;
  errorCode?: string | null;
  finishReason?: string;
  isTextPaused?: boolean;
  isTextInterrupted?: boolean;
  mentionedSourceIds?: string[];
  effectiveMentionedSourceIds?: string[];
  sourceIds?: string[];
  effectiveSourceIds?: string[];
  sourceAssistantMessageId?: string | null;
  sourceUserMessageId?: string | null;
  toolCalls?: ToolCallRecord[];
  thinkingSteps?: ThinkingStepRecord[];
  renderBlocks?: MessageRenderBlock[];
  modelReasoning?: string;
  modelReasoningSegments?: ModelReasoningSegmentRecord[];
  traceEvents?: ReasoningTraceEventRecord[];
  traceParts?: TracePartRecord[];
  threadRun?: {
    id?: string;
    idempotencyKey?: string;
    status?: string;
    mode?: "send" | "refresh" | "edit" | "resume";
    approvalRequestedAt?: string | null;
    approvalExpiresAt?: string | null;
  };
};

export type AssistantVersionIndexEntry = {
  branchIndex: number;
  groupId: string;
  version: MessageVersion;
};

export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingMode = "auto" | "off" | "effort";

export type PromptThinkingSettings = {
  mode: ThinkingMode;
  effort: ThinkingEffort;
};

export type PromptThinkingCapabilities = {
  supportsThinking: boolean;
  supportedParameters?: string[];
  supportedEfforts?: ThinkingEffort[];
  reasoning?: boolean;
  reasoningEffort?: boolean;
  includeReasoning?: boolean;
  supportSources?: string[];
  imageGeneration?: ImageModelCapabilities;
};

export type ImageAspectRatio =
  | "auto"
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9"
  | "1:4"
  | "4:1"
  | "1:8"
  | "8:1";
export type ImageQuality = "auto" | "low" | "standard" | "higher" | "highest";
export type ImageStyle = "auto" | "ghibli" | "pixar" | "cartoon" | "pixel";

export type ImageModelCapabilities = {
  supported: boolean;
  provider?: string;
  controls?: {
    aspectRatio?: {
      values: ImageAspectRatio[];
    };
    quality?: {
      values: ImageQuality[];
    };
    style?: {
      values: ImageStyle[];
    };
  };
};

export type ChatImageArtifactConfig = {
  aspectRatio: ImageAspectRatio;
  quality: ImageQuality;
  style: ImageStyle;
};

export type ChatGenerateImageToolSelection = {
  enabled?: boolean;
  mode?: "auto" | "generate";
  modelAlias?: string;
  execution?: Record<string, unknown>;
  config?: ChatImageArtifactConfig;
};

export type ChatConnectorToolSelection = {
  enabled?: boolean;
  connectorId?: string;
};

export type ChatToolName = AgentToolName;

export type ChatToolsSelection = {
  [AGENT_TOOL_NAMES.generateImage]?: ChatGenerateImageToolSelection;
  [AGENT_TOOL_NAMES.searchNotionPages]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.readNotionPage]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.createNotionPage]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.appendNotionPage]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.updateNotionPage]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.deleteNotionPage]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.saveArtifactToNotion]?: ChatConnectorToolSelection;
  [AGENT_TOOL_NAMES.saveFinalAnswerToNotion]?: ChatConnectorToolSelection;
  mcp?: McpToolSelection;
  invokedSkillIds?: string[];
};

export type ChatSkillItem = {
  id: string;
  catalogId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: "builtin" | "workspace_custom" | "team_custom";
  version: string;
  hasReadme: boolean;
  capabilities?: {
    required?: string[];
    optional?: string[];
  };
  models?: {
    chat?: string;
    image?: string;
    vision?: string;
  };
  commands?: SkillCommand[];
  tools?: string[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
};

export type CitationRecord = {
  citation: string;
  sourceId: string | null;
  sourceTitle?: string;
  documentId: string | null;
  chunkId: string;
  chunkNo?: number;
  score: number;
  excerpt: string;
  content?: string;
  externalUri?: string;
};

export type ArtifactPreviewRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string | null;
  artifactType:
    | "report"
    | "slides"
    | "mindmap"
    | "podcast"
    | "audio_overview"
    | "video_overview"
    | "flashcards"
    | "quiz"
    | "table"
    | "infographic"
    | "image";
  status: "pending" | "running" | "ready" | "failed" | "archived";
  title: string | null;
  promptText: string | null;
  payloadJson: Record<string, unknown>;
  storageBucket: string | null;
  storageKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl: string | null;
};

export type ToolCallRecord = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number | null;
  status: "running" | "approval_requested" | "completed" | "error";
  error: string | null;
  sequence?: number;
  approvalState?: "approved" | "rejected";
  approvalConfirmationId?: string;
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

export type ThinkingStepRecord = {
  id: string;
  kind?: "log" | "state" | "verification" | "reasoning_summary";
  title: string;
  status: "pending" | "in_progress" | "completed";
  items: string[];
  sequence?: number;
  description?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
};

export type ModelReasoningSegmentRecord = {
  id: string;
  text: string;
  sequence?: number;
  durationMs?: number;
  phase?: "initial" | "after_tool";
  toolCallId?: string;
  tool?: string;
};

export type ReasoningTraceEventRecord =
  | {
      type: "reasoning";
      id: string;
      displayOrder?: number;
      itemId?: string;
      sequence?: number;
      reasoning?: string;
      segment: ModelReasoningSegmentRecord;
    }
  | {
      type: "tool-call";
      id: string;
      displayOrder?: number;
      itemId?: string;
      sequence?: number;
      eventType?: string;
      tool?: string;
      toolCall?: ToolCallRecord;
      payload?: Record<string, unknown>;
    }
  | {
      type: "thinking-step";
      id: string;
      displayOrder?: number;
      itemId?: string;
      sequence?: number;
      step: ThinkingStepRecord;
    };

export type TracePartRecord =
  | {
      id: string;
      kind: "reasoning";
      order: number;
      createdAt: string;
      updatedAt: string;
      text: string;
      phase?: "initial" | "after_tool";
      toolCallId?: string;
      tool?: string;
      durationMs?: number;
    }
  | {
      id: string;
      kind: "tool";
      order: number;
      createdAt: string;
      updatedAt: string;
      toolCallId: string;
      tool: string;
      status: ToolCallRecord["status"];
      input: Record<string, unknown>;
      output?: unknown;
      error?: string | null;
      latencyMs?: number | null;
      title?: string;
      approvalState?: ToolCallRecord["approvalState"];
      approvalConfirmationId?: string;
    }
  | {
      id: string;
      kind: "step";
      order: number;
      createdAt: string;
      updatedAt: string;
      title: string;
      status: ThinkingStepRecord["status"];
      items: string[];
      metadata?: Record<string, unknown>;
    };

export type VersionedMessageGroup = {
  groupId: string;
  turnId?: string;
  role: "user" | "assistant";
  versions: MessageVersion[];
  latestVersionId: string;
};
