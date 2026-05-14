import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type ChatInputImage,
  type ChatMessageImagePart,
  type SkillCommand,
  type ThreadCommandRequest,
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

export type ChatToolName = AgentToolName;

export type ChatToolsSelection = {
  [AGENT_TOOL_NAMES.generateImage]?: ChatGenerateImageToolSelection;
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
  status: "running" | "completed" | "error";
  error: string | null;
  sequence?: number;
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
};

export type VersionedMessageGroup = {
  groupId: string;
  turnId?: string;
  role: "user" | "assistant";
  versions: MessageVersion[];
  latestVersionId: string;
};
