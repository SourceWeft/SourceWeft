import type {
  ModelCapabilityRule,
  ProviderRoutingConfig,
} from "@sourceweft/model-gateway";
import type {
  ModelGatewayProviderKind,
  ModelGatewayRoutingStrategy,
} from "@sourceweft/db";

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
      kind: ModelGatewayProviderKind;
      baseUrl: string;
      apiKey?: string;
      apiKeyHeaderName?: string;
      apiKeyHeaderPrefix?: string;
      isBYOK: boolean;
      enabled: boolean;
      configured: boolean;
      globalReady: boolean;
      requiresGlobalApiKey: boolean;
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
      strategy: ModelGatewayRoutingStrategy;
      /**
       * Selection candidates, NOT a failover chain. Exactly one target is
       * chosen per request by `strategy`, and retries stay on that target —
       * a dead provider is never swapped out mid-request. Treat `priority`
       * as static preference ordering, not high availability.
       */
      targets: Array<{
        provider: string;
        model: string;
        priority?: number;
        weight?: number;
        providerRouting?: ProviderRoutingConfig;
      }>;
    }
  >;
  /** Deployment-declared capability rules; the shipped DB is merged in later. */
  modelCapabilities?: ModelCapabilityRule[];
};
