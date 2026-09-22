import { loadRoutedGatewayConfig } from "../../../shared/model-gateway/runtime";
import type {
  RuntimeModelGatewayProfile,
  RoutedGatewayConfig,
} from "../../../shared/model-gateway/types";
import { skillAnalysisModelConfigurationKey } from "./analysis-evaluation";

/** Select only inference topology and non-secret provider identity. Never hash raw config. */
export function analysisRoutingIdentity(
  profile: Pick<RuntimeModelGatewayProfile, "profileAlias" | "modelAlias">,
  config: RoutedGatewayConfig,
) {
  return [...new Set([profile.profileAlias, profile.modelAlias])]
    .sort()
    .map((alias) => {
      const route = config.modelRoutes[alias];
      if (!route) return { alias, route: null };
      return {
        alias,
        strategy: route.strategy,
        targets: route.targets.map((target) => {
          const provider = config.providers[target.provider];
          const url = provider ? new URL(provider.baseUrl) : null;
          return {
            provider: target.provider,
            model: target.model,
            priority: target.priority,
            weight: target.weight,
            kind: provider?.kind,
            baseUrl: url ? `${url.origin}${url.pathname}` : null,
            apiVersion: url?.searchParams.get("api-version") ?? null,
            globalReady: provider?.globalReady ?? false,
            providerRouting: target.providerRouting ?? null,
          };
        }),
      };
    });
}
export async function resolveSkillAnalysisModelKey(
  profile: RuntimeModelGatewayProfile,
) {
  const config = await loadRoutedGatewayConfig();
  if (!config) throw new Error("Global model routing is not configured");
  return skillAnalysisModelConfigurationKey(
    profile,
    analysisRoutingIdentity(profile, config),
  );
}
