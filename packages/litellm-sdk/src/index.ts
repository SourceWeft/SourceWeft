export { createLiteLLMSDK, LiteLLMClient } from "./client";

export {
  LiteLLMError,
  isRetryableError,
  normalizeLiteLLMError,
  toUnifiedError,
} from "./errors";

export { LiteLLMRouter } from "./router/litellm-router";

export { DEFAULT_ALLOWED_MODEL_ALIASES, resolveLiteLLMConfig } from "./config";

export { normalizeToolChoice } from "./compat/tool-choice";
export {
  buildStructuredOutputRequest,
  toStrictJsonSchema,
} from "./compat/structured-output";

export {
  type ChatCompleteInput,
  type ChatCompleteResult,
  type ChatStreamEvent,
  type ChatStreamInput,
  type DefaultModelAlias,
  type EmbedBatchInput,
  type EmbedBatchResult,
  type EmbedInput,
  type EmbedResult,
  type LiteLLMClientConfig,
  type LiteLLMMessage,
  type LiteLLMRequestMetadata,
  type LiteLLMResponseFormat,
  type LiteLLMRouterOptions,
  type LiteLLMSDK,
  type LiteLLMStructuredOutputConfig,
  type LiteLLMToolChoice,
  type LiteLLMToolDefinition,
  type ModelAlias,
  type RequestOptions,
  type RerankInput,
  type RerankItem,
  type RerankResult,
  type UnifiedError,
  type UsageInfo,
} from "./types";
