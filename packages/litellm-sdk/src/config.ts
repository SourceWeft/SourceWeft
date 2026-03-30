import { LiteLLMError } from "./errors";
import type {
  DefaultModelAlias,
  LiteLLMClientConfig,
  RequestOptions,
  ResolvedLiteLLMClientConfig,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export const DEFAULT_ALLOWED_MODEL_ALIASES: readonly DefaultModelAlias[] = [
  "chat-default",
  "embed-default",
  "rerank-default",
];

function normalizeBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message: `Invalid LiteLLM baseUrl: ${baseUrl}`,
      retryable: false,
    });
  }
}

function ensureBaseUrlAllowed(baseUrl: string, allowed: readonly string[]) {
  if (allowed.length === 0) {
    return;
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedAllowed = allowed.map((item) => normalizeBaseUrl(item));

  if (!normalizedAllowed.includes(normalizedBase)) {
    throw new LiteLLMError({
      code: "AUTH",
      message: `LiteLLM baseUrl is not in allow list: ${normalizedBase}`,
      retryable: false,
    });
  }
}

export function resolveLiteLLMConfig(
  config: LiteLLMClientConfig,
): ResolvedLiteLLMClientConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchFn = config.fetch ?? globalThis.fetch;

  if (typeof fetchFn !== "function") {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message: "A fetch implementation is required for LiteLLM client",
      retryable: false,
    });
  }

  ensureBaseUrlAllowed(baseUrl, config.allowedBaseUrls ?? []);

  return {
    baseUrl,
    apiKey: config.apiKey,
    fetch: fetchFn,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    defaultHeaders: {
      "Content-Type": "application/json",
      ...(config.defaultHeaders ?? {}),
    },
    allowNonDefaultAliases: config.allowNonDefaultAliases ?? false,
    allowedModelAliases:
      config.allowedModelAliases && config.allowedModelAliases.length > 0
        ? config.allowedModelAliases
        : DEFAULT_ALLOWED_MODEL_ALIASES,
    logger: config.logger ?? {},
    requestMetadata: config.requestMetadata ?? {},
  };
}

export function assertModelAliasAllowed(
  model: string,
  config: ResolvedLiteLLMClientConfig,
) {
  if (config.allowNonDefaultAliases) {
    return;
  }

  if (!config.allowedModelAliases.includes(model)) {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message:
        `Model alias '${model}' is not allowed. ` +
        `Allowed aliases: ${config.allowedModelAliases.join(", ")}`,
      retryable: false,
    });
  }
}

export function buildRequestHeaders(
  config: ResolvedLiteLLMClientConfig,
  options?: RequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...config.defaultHeaders,
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  return headers;
}
