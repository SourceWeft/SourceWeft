import type { ProviderRoutingConfig } from "@sourceweft/model-gateway";

export type ModelGatewayProfileKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type RuntimeModelGatewayProfile = {
  id: string;
  kind: ModelGatewayProfileKind;
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias: string;
  requestedDimensions: number | null;
  vectorStrategy: "auto" | "exact" | "disabled";
  isDefault: boolean;
  isActive: boolean;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RoutedGatewayConfig = {
  versionId: string;
  providers: Record<
    string,
    {
      gatewayConfigId: string | null;
      kind:
        | "openai-compatible"
        | "openrouter"
        | "deepinfra"
        | "siliconflow-cn"
        | "openai"
        | "anthropic"
        | "gemini"
        | "azure-openai";
      baseUrl: string;
      apiKey?: string;
      apiKeyHeaderName?: string;
      apiKeyHeaderPrefix?: string;
      isBYOK: boolean;
      hasGlobalApiKey: boolean;
      defaultHeaders: Record<string, string>;
      supports: string[];
      timeoutMs: number;
      maxRetries: number;
    }
  >;
  modelRoutes: Record<
    string,
    {
      strategy:
        | "priority"
        | "weighted-random"
        | "least-latency"
        | "cost-aware"
        | "sticky-by-tenant";
      targets: Array<{
        provider: string;
        model: string;
        priority?: number;
        weight?: number;
        providerRouting?: ProviderRoutingConfig;
      }>;
    }
  >;
};
