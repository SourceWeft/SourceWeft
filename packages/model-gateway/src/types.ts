import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";

export type ModelKind =
  | "chat"
  | "embedding"
  | "rerank"
  | "asr"
  | "tts"
  | "image"
  | "vision"
  | "video";

export type GatewayErrorCode =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH"
  | "BAD_REQUEST"
  | "UPSTREAM"
  | "POLICY"
  | "QUOTA"
  | "UNKNOWN";

export interface GatewayErrorData {
  code: GatewayErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
  provider?: string;
  requestId?: string;
}

export type GatewayExecutionMode = "GLOBAL" | "BYOK";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingMode = "auto" | "off" | "effort";

export interface ThinkingConfig {
  mode?: ThinkingMode;
  enabled?: boolean;
  effort?: ReasoningEffort;
  includeReasoning?: boolean;
  supportedParameters?: string[];
  supportedEfforts?: ReasoningEffort[];
}

export type ProviderKind =
  | "openai-compatible"
  | "cloudflare-aig"
  | "openrouter"
  | "deepinfra"
  | "siliconflow-cn"
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure-openai"
  | (string & {});

/**
 * Only strategies implemented by selectTargetByStrategy are declared here.
 * Adding a value without a matching implementation makes misconfiguration a
 * runtime failure on the first request instead of a config-parse error.
 */
export type RoutingStrategy = "priority" | "weighted-random";

export interface ByokCredentialsInput {
  provider: string;
  providerKind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  apiKeyRef?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
  allowFallback?: boolean;
}

export interface GatewayExecutionInput {
  executionMode?: GatewayExecutionMode;
  // Global-only route identity. BYOK requests should route by provider + providerModel.
  profileAlias?: string;
  providerHint?: string;
  byokModelId?: string;
  credentialId?: string;
  byok?: ByokCredentialsInput;
}

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  traceId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  suppressLangChainObservation?: boolean;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  inputImageTokens?: number;
  outputImageTokens?: number;
  inputImageCount?: number;
  outputImageCount?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  providerCostUsd?: number;
  providerCostSource?:
    | "usage.cost"
    | "usage.cost_details.upstream_inference_cost"
    | "usage.estimated_cost"
    | "inference_status.cost";
  costDetails?: Record<string, number>;
}

export interface ObserveSpan {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  endedAt: string;
  status: "ok" | "error";
  attributes?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export type ObserveRawCaptureMode =
  | "none"
  | "normalized"
  | "sdk_metadata"
  | "reconstructed"
  | "provider_wire";

export interface ObserveGenerationStart {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  operation: GatewayOperation;
  name?: string;
  startedAt: string;
  modelAlias: string;
  provider: string;
  providerModel: string;
  executionMode?: GatewayExecutionMode;
  routeDecision?: RouteDecision;
  modelParameters?: Record<string, unknown>;
  input?: Record<string, unknown>;
  rawCaptureMode?: ObserveRawCaptureMode;
  attributes?: Record<string, unknown>;
}

export interface ObserveGenerationEnd {
  traceId?: string;
  spanId: string;
  endedAt: string;
  latencyMs?: number;
  output?: Record<string, unknown>;
  outputText?: string;
  finishReason?: string;
  reasoningText?: string;
  providerFields?: Record<string, unknown>;
  usage?: UsageInfo;
  rawCaptureMode?: ObserveRawCaptureMode;
  providerResponse?: Record<string, unknown>;
  providerStatusCode?: number;
  providerRequestId?: string;
  rawCaptureError?: string;
  attributes?: Record<string, unknown>;
}

export interface ObserveGenerationError {
  traceId?: string;
  spanId: string;
  endedAt: string;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  providerResponse?: Record<string, unknown>;
  providerStatusCode?: number;
  providerRequestId?: string;
  rawCaptureError?: string;
  attributes?: Record<string, unknown>;
}

// Optional sink implemented by host apps; the gateway emits events but does not own persistence.
export interface ObserveSink {
  onSpan?(span: ObserveSpan): void | Promise<void>;
  onGenerationStart?(generation: ObserveGenerationStart): void | Promise<void>;
  onGenerationEnd?(generation: ObserveGenerationEnd): void | Promise<void>;
  onGenerationError?(generation: ObserveGenerationError): void | Promise<void>;
}

export interface GatewayLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  argsJson?: string;
}

export interface GatewayMessage {
  role: MessageRole;
  content: GatewayMessageContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  providerFields?: Record<string, unknown>;
}

export type GatewayMessageContent = string | GatewayMessageContentPart[];

export type GatewayMessageContentPart =
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

export interface GatewayRequestMetadata {
  teamId?: string;
  team_id?: string;
  workspaceId?: string;
  workspace_id?: string;
  userId?: string;
  user_id?: string;
  threadId?: string;
  thread_id?: string;
  messageId?: string;
  message_id?: string;
  feature?: string;
  [key: string]: unknown;
}

export type ToolDefinition = Record<string, unknown>;

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | "any"
  | string
  | Record<string, unknown>;

export interface ToolBindingOptions {
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  [key: string]: unknown;
}

export interface StructuredOutputConfig {
  /**
   * Structured-output method. When omitted, LangChain selects a default per
   * model. Callers should normally omit this.
   */
  method?: "json_schema" | "json_mode" | "function_calling";
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  /** Only forwarded when {@link method} is set explicitly. */
  strict?: boolean;
}

export interface GatewayProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
  supports?: readonly string[];
  enabled?: boolean;
  /** Falls back to the gateway-wide value when unset. */
  timeoutMs?: number;
  /** Falls back to the gateway-wide value when unset. */
  maxRetries?: number;
}

export type ProviderRoutingSortBy = "price" | "throughput" | "latency";

export type ProviderRoutingSort =
  | ProviderRoutingSortBy
  | {
      by: ProviderRoutingSortBy;
      partition: "model" | "none";
    };

export interface ProviderRoutingConfig {
  only?: string[];
  sort?: ProviderRoutingSort;
}

export interface ModelRouteTarget {
  provider: string;
  model: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
  providerRouting?: ProviderRoutingConfig;
}

export interface ModelRouteConfig {
  strategy?: RoutingStrategy;
  targets: ModelRouteTarget[];
}

export interface RouteDecision {
  alias: string;
  mode: GatewayExecutionMode;
  strategy: RoutingStrategy;
  provider: string;
  providerKind: ProviderKind;
  providerRouting?: ProviderRoutingConfig;
}

export type GatewayOperation =
  | "chat.complete"
  | "chat.stream"
  | "embeddings.embed"
  | "embeddings.embedBatch"
  | "rerank.rank"
  | "asr.transcribe"
  | "tts.speech"
  | "images.generate";

export interface LangChainChatModelLike {
  getName?(): string;
  bindTools?(
    tools: unknown[],
    kwargs?: Record<string, unknown>,
  ): LangChainChatModelLike;
  withStructuredOutput?(
    schema: Record<string, unknown>,
    config: {
      includeRaw: true;
      // Optional: when omitted, LangChain selects the best method per model.
      method?: "jsonSchema" | "functionCalling" | "jsonMode";
      name: string;
      strict?: boolean;
    },
  ): {
    invoke(
      input: unknown,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  invoke(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  stream(
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
}

export interface LangChainEmbeddingsLike {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface LangChainRerankerLike {
  rerank?(
    docs: Array<{ pageContent: string; metadata?: Record<string, unknown> }>,
    query: string,
    options?: { topN?: number },
  ): Promise<Array<{ index: number; relevanceScore: number }>>;
  compressDocuments?(
    docs: Array<{ pageContent: string; metadata?: Record<string, unknown> }>,
    query: string,
  ): Promise<Array<{ pageContent: string; metadata?: Record<string, unknown> }>>;
}

export interface LangChainFactories {
  createChatModel?: (input: {
    target: ResolvedRequestTarget;
    payload: ChatCompleteInput;
    options?: RequestOptions;
    config: ResolvedModelGatewayConfig;
  }) => LangChainChatModelLike;
  createEmbeddingsModel?: (input: {
    target: ResolvedRequestTarget;
    payload: EmbedInput | EmbedBatchInput;
    options?: RequestOptions;
    config: ResolvedModelGatewayConfig;
  }) => LangChainEmbeddingsLike;
  createReranker?: (input: {
    target: ResolvedRequestTarget;
    payload: RerankInput;
    options?: RequestOptions;
    config: ResolvedModelGatewayConfig;
  }) => LangChainRerankerLike;
}

export interface ChatCompleteInput extends GatewayExecutionInput {
  model: string;
  messages: GatewayMessage[];
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  toolBindingOptions?: ToolBindingOptions;
  structuredOutput?: StructuredOutputConfig;
  metadata?: GatewayRequestMetadata;
  thinking?: ThinkingConfig;
  extraBody?: Record<string, unknown>;
}

export type ChatStreamInput = ChatCompleteInput;

export interface ChatCompleteResult {
  id?: string;
  model: string;
  usage?: UsageInfo;
  finishReason?: string;
  reasoning?: string;
  providerFields?: Record<string, unknown>;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  structuredOutput?: Record<string, unknown>;
  raw: AIMessage;
}

export type ChatStreamEvent =
  | {
      type: "chunk";
      chunk: AIMessageChunk;
    }
  | {
      type: "metadata";
      metadata: {
        usage?: UsageInfo;
        finishReason?: string;
        reasoning?: string;
        providerFields?: Record<string, unknown>;
        routeDecision?: RouteDecision;
        traceId?: string;
      };
    }
  | {
      type: "error";
      error: GatewayErrorData;
    };

export interface EmbedInput extends GatewayExecutionInput {
  model: string;
  text: string;
  inputType?: string;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface EmbedBatchInput extends GatewayExecutionInput {
  model: string;
  texts: string[];
  inputType?: string;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface EmbedResult {
  model: string;
  embedding: number[];
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

export interface EmbedBatchResult {
  model: string;
  embeddings: number[][];
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

export interface RerankInput extends GatewayExecutionInput {
  model: string;
  query: string;
  documents: Array<string | Record<string, unknown>>;
  topN?: number;
  returnDocuments?: boolean;
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface RerankItem {
  index: number;
  relevanceScore: number;
  document?: Record<string, unknown>;
}

export interface RerankResult {
  model: string;
  results: RerankItem[];
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

export type AsrAudioInput = Blob | ArrayBuffer | Uint8Array;

export type AsrResponseFormat =
  | "json"
  | "text"
  | "srt"
  | "verbose_json"
  | "vtt";

export type AsrTimestampGranularity = "segment" | "word";

export interface AsrTranscribeInput extends GatewayExecutionInput {
  model: string;
  audio: AsrAudioInput;
  fileName: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: AsrResponseFormat;
  timestampGranularities?: AsrTimestampGranularity[];
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface AsrSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
}

export interface AsrWord {
  start: number;
  end: number;
  text: string;
}

export interface AsrTranscribeResult {
  model: string;
  text: string;
  language?: string;
  duration?: number;
  inputLengthMs?: number;
  segments?: AsrSegment[];
  words?: AsrWord[];
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

export type TtsResponseFormat =
  | "mp3"
  | "opus"
  | "aac"
  | "flac"
  | "wav"
  | "pcm"
  | (string & {});

export interface TtsSpeechInput extends GatewayExecutionInput {
  model: string;
  input: string;
  voice?: string;
  instructions?: string;
  responseFormat?: TtsResponseFormat;
  speed?: number;
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface TtsSpeechResult {
  model: string;
  audio: ArrayBuffer;
  mimeType?: string;
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

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
export type ImageResponseFormat = "url" | "b64_json";

export interface ImageGenerateInput extends GatewayExecutionInput {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: ImageAspectRatio;
  quality?: ImageQuality;
  style?: ImageStyle;
  count?: number;
  responseFormat?: ImageResponseFormat;
  metadata?: GatewayRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface GeneratedImage {
  mimeType?: string;
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
  width?: number;
  height?: number;
}

export interface ImageGenerateResult {
  model: string;
  images: GeneratedImage[];
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: RouteDecision;
  traceId?: string;
  raw: Record<string, unknown>;
}

export interface ModelGateway {
  chat: {
    complete(
      input: ChatCompleteInput,
      opts?: RequestOptions,
    ): Promise<ChatCompleteResult>;
    stream(
      input: ChatStreamInput,
      opts?: RequestOptions,
    ): AsyncIterable<ChatStreamEvent>;
  };
  embeddings: {
    embed(input: EmbedInput, opts?: RequestOptions): Promise<EmbedResult>;
    embedBatch(
      input: EmbedBatchInput,
      opts?: RequestOptions,
    ): Promise<EmbedBatchResult>;
  };
  rerank: {
    rank(input: RerankInput, opts?: RequestOptions): Promise<RerankResult>;
  };
  asr: {
    transcribe(
      input: AsrTranscribeInput,
      opts?: RequestOptions,
    ): Promise<AsrTranscribeResult>;
  };
  tts: {
    speech(
      input: TtsSpeechInput,
      opts?: RequestOptions,
    ): Promise<TtsSpeechResult>;
  };
  images: {
    generate(
      input: ImageGenerateInput,
      opts?: RequestOptions,
    ): Promise<ImageGenerateResult>;
  };
}

export interface ModelGatewayConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  providers?: Record<string, GatewayProviderConfig>;
  modelRoutes?: Record<string, ModelRouteConfig>;
  modeDefault?: GatewayExecutionMode;
  routingStrategyDefault?: RoutingStrategy;
  byokProviderAllowList?: readonly string[];
  resolveApiKeyRef?: (input: {
    provider: string;
    apiKeyRef: string;
    metadata?: Record<string, unknown>;
  }) => Promise<string | null | undefined>;
  resolveCustomByokProvider?: (input: {
    provider: string;
    model: string;
    profileAlias?: string;
    apiKey?: string;
    apiKeyRef?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<CustomByokProviderConfig | null | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  allowNonDefaultAliases?: boolean;
  allowedModelAliases?: readonly string[];
  allowedBaseUrls?: readonly string[];
  logger?: GatewayLogger;
  requestMetadata?: Record<string, unknown>;
  observeSink?: ObserveSink;
  langchainFactories?: LangChainFactories;
}

export interface ResolvedGatewayProviderConfig {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders: Record<string, string>;
  supports: readonly string[];
  enabled: boolean;
  /** Falls back to the gateway-wide value when unset. */
  timeoutMs?: number;
  /** Falls back to the gateway-wide value when unset. */
  maxRetries?: number;
}

export interface CustomByokProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
  supports?: readonly string[];
  enabled?: boolean;
}

export interface ResolvedModelRouteTarget {
  provider: string;
  model: string;
  weight: number;
  priority: number;
  enabled: boolean;
  providerRouting?: ProviderRoutingConfig;
}

export interface ResolvedModelRouteConfig {
  alias: string;
  strategy: RoutingStrategy;
  targets: ResolvedModelRouteTarget[];
}

export interface ResolvedModelGatewayConfig {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  providers: Record<string, ResolvedGatewayProviderConfig>;
  routes: Record<string, ResolvedModelRouteConfig>;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
  allowNonDefaultAliases: boolean;
  allowedModelAliases: readonly string[];
  allowedBaseUrls: readonly string[];
  modeDefault: GatewayExecutionMode;
  routingStrategyDefault: RoutingStrategy;
  byokProviderAllowList: readonly string[];
  resolveApiKeyRef?: ModelGatewayConfig["resolveApiKeyRef"];
  resolveCustomByokProvider?: ModelGatewayConfig["resolveCustomByokProvider"];
  logger: GatewayLogger;
  requestMetadata: Record<string, unknown>;
  observeSink?: ObserveSink;
  langchainFactories?: LangChainFactories;
}

export interface ResolvedRequestTarget {
  provider: string;
  providerKind: ProviderKind;
  providerModel: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders: Record<string, string>;
  supports: readonly string[];
  providerRouting?: ProviderRoutingConfig;
  routeDecision: RouteDecision;
  requestMetadata: Record<string, unknown>;
  /** Provider-specific overrides; unset means use the gateway-wide value. */
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ResolvedRequestConfig {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
  logger: GatewayLogger;
  requestMetadata: Record<string, unknown>;
  observeSink?: ObserveSink;
  langchainFactories?: LangChainFactories;
}
