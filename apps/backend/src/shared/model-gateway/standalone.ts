import type { ModelGatewayProviderKind } from "@sourceweft/db";
import { withOpenRouterAttributionHeaders } from "./runtime";
import type { RoutedGatewayConfig } from "./types";

/**
 * A provider a feature declares for itself, outside the global gateway
 * configuration: it has no gateway config row, is never offered as a model,
 * never enters GLOBAL routing and does not follow any `*_ENABLED` activation.
 * The feature calls it through `withBilledModelGateway({ standaloneConfig })`,
 * so the call is still admitted, billed and observed like any other.
 */
export type StandaloneProvider = {
  /** Snapshot id, provider name and route alias in one. */
  id: string;
  providerKind: ModelGatewayProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  supports: string[];
  timeoutMs: number;
  maxRetries: number;
};

/** The one-provider, one-route gateway snapshot for a standalone provider. */
export function buildStandaloneGatewayConfig(
  provider: StandaloneProvider,
): RoutedGatewayConfig {
  return {
    versionId: `standalone:${provider.id}`,
    providers: {
      [provider.id]: {
        gatewayConfigId: null,
        kind: provider.providerKind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        isBYOK: false,
        enabled: true,
        configured: true,
        globalReady: true,
        requiresGlobalApiKey: true,
        hasGlobalApiKey: true,
        defaultHeaders: withOpenRouterAttributionHeaders({
          providerKind: provider.providerKind,
        }),
        supports: provider.supports,
        timeoutMs: provider.timeoutMs,
        maxRetries: provider.maxRetries,
      },
    },
    modelRoutes: {
      [provider.id]: {
        strategy: "priority",
        targets: [{ provider: provider.id, model: provider.model }],
      },
    },
  };
}
