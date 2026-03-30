export type DefaultModelAlias =
  | "chat-default"
  | "embed-default"
  | "rerank-default";

export type ModelAlias = DefaultModelAlias | (string & {});

export type UnifiedErrorCode =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH"
  | "BAD_REQUEST"
  | "UPSTREAM"
  | "UNKNOWN";

export interface UnifiedError {
  code: UnifiedErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
  provider?: string;
  requestId?: string;
}

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  traceId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type LiteLLMMessageRole = "system" | "user" | "assistant" | "tool";

export interface LiteLLMToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  argsJson?: string;
}

export interface LiteLLMMessage {
  role: LiteLLMMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LiteLLMToolCall[];
  reasoningContent?: string;
  providerFields?: Record<string, unknown>;
}

export type LiteLLMToolDefinition = Record<string, unknown>;

export type LiteLLMToolChoice =
  | "auto"
  | "none"
  | "required"
  | "any"
  | string
  | Record<string, unknown>;

export type StructuredOutputMethod =
  | "json_schema"
  | "json_mode"
  | "function_calling";

export interface LiteLLMStructuredOutputConfig {
  method?: StructuredOutputMethod;
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

export type LiteLLMResponseFormat =
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        description?: string;
        strict?: boolean;
      };
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface LiteLLMRequestMetadata {
  team_id?: string;
  workspace_id?: string;
  user_id?: string;
  thread_id?: string;
  feature?: string;
  [key: string]: unknown;
}

export interface ChatCompleteInput {
  model: ModelAlias;
  messages: LiteLLMMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: LiteLLMToolDefinition[];
  toolChoice?: LiteLLMToolChoice;
  responseFormat?: LiteLLMResponseFormat;
  structuredOutput?: LiteLLMStructuredOutputConfig;
  metadata?: LiteLLMRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export type ChatStreamInput = ChatCompleteInput;

export interface ChatCompleteResult {
  id?: string;
  model: string;
  outputText: string;
  message: LiteLLMMessage;
  usage?: UsageInfo;
  finishReason?: string;
  reasoning?: string;
  providerFields?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export type ChatStreamEvent =
  | {
      type: "token";
      text: string;
    }
  | {
      type: "tool_call";
      name: string;
      argsJson: string;
    }
  | {
      type: "usage";
      usage: UsageInfo;
    }
  | {
      type: "reasoning";
      content: string;
    }
  | {
      type: "provider_fields";
      data: Record<string, unknown>;
    }
  | {
      type: "done";
      finishReason?: string;
    }
  | {
      type: "error";
      error: UnifiedError;
    };

export interface EmbedInput {
  model: ModelAlias;
  text: string;
  inputType?: string;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  metadata?: LiteLLMRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface EmbedBatchInput {
  model: ModelAlias;
  texts: string[];
  inputType?: string;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  metadata?: LiteLLMRequestMetadata;
  extraBody?: Record<string, unknown>;
}

export interface EmbedResult {
  model: string;
  embedding: number[];
  usage?: UsageInfo;
  raw: Record<string, unknown>;
}

export interface EmbedBatchResult {
  model: string;
  embeddings: number[][];
  usage?: UsageInfo;
  raw: Record<string, unknown>;
}

export interface RerankInput {
  model: ModelAlias;
  query: string;
  documents: Array<string | Record<string, unknown>>;
  topN?: number;
  returnDocuments?: boolean;
  metadata?: LiteLLMRequestMetadata;
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
  raw: Record<string, unknown>;
}

export interface LiteLLMSDK {
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
}

export interface LiteLLMLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

export interface LiteLLMClientConfig {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  allowNonDefaultAliases?: boolean;
  allowedModelAliases?: readonly string[];
  allowedBaseUrls?: readonly string[];
  logger?: LiteLLMLogger;
  requestMetadata?: Record<string, unknown>;
}

export interface ResolvedLiteLLMClientConfig {
  baseUrl: string;
  apiKey?: string;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
  allowNonDefaultAliases: boolean;
  allowedModelAliases: readonly string[];
  logger: LiteLLMLogger;
  requestMetadata: Record<string, unknown>;
}

export type RouterStrategy = "round_robin" | "random";

export interface LiteLLMRouterOptions {
  chatModels: readonly ModelAlias[];
  embeddingModels?: readonly ModelAlias[];
  rerankModels?: readonly ModelAlias[];
  strategy?: RouterStrategy;
  maxAttemptsPerRequest?: number;
}
