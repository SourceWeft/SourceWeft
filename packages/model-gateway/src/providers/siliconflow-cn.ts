import type { GatewayProviderConfig } from "../types";

export function createSiliconflowCNProvider(input: {
  baseUrl?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  supports?: readonly string[];
}): GatewayProviderConfig {
  return {
    kind: "siliconflow-cn",
    baseUrl: input.baseUrl ?? "https://api.siliconflow.cn/v1",
    apiKey: input.apiKey,
    defaultHeaders: input.defaultHeaders,
    supports: input.supports ?? [
      "chat",
      "embeddings",
      "rerank",
      "asr",
      "image",
      "tool_calling",
      "json_schema",
    ],
    enabled: true,
  };
}
