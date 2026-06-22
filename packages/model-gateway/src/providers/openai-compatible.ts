import type { GatewayProviderConfig } from "../types";

export function createOpenAICompatibleProvider(input: {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
  supports?: readonly string[];
}): GatewayProviderConfig {
  return {
    kind: "openai-compatible",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyHeaderName: input.apiKeyHeaderName,
    apiKeyHeaderPrefix: input.apiKeyHeaderPrefix,
    defaultHeaders: input.defaultHeaders,
    supports: input.supports ?? ["chat", "embeddings", "rerank"],
    enabled: true,
  };
}
