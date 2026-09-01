import type { ProviderResponseAdapter } from "../../observation/types";
import { deepInfraProviderAdapter } from "./deepinfra/response";
import { openRouterProviderAdapter } from "./openrouter/response";
import { orcaRouterProviderAdapter } from "./orcarouter";

const providerResponseAdapters = new Map<string, ProviderResponseAdapter>([
  ["deepinfra", deepInfraProviderAdapter],
  ["openrouter", openRouterProviderAdapter],
  ["orcarouter", orcaRouterProviderAdapter],
]);

export function getProviderResponseAdapter(
  provider: string,
): ProviderResponseAdapter | undefined {
  return providerResponseAdapters.get(provider.trim().toLowerCase());
}
