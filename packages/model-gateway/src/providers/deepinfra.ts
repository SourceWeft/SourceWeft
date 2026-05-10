import type { GatewayProviderConfig } from "../types";

export function createDeepInfraProvider(input: {
  baseUrl?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  supports?: readonly string[];
}): GatewayProviderConfig {
  return {
    kind: "deepinfra",
    baseUrl: input.baseUrl ?? "https://api.deepinfra.com/v1",
    apiKey: input.apiKey,
    defaultHeaders: input.defaultHeaders,
    supports: input.supports ?? ["chat", "embeddings", "rerank", "asr", "image"],
    enabled: true,
  };
}
