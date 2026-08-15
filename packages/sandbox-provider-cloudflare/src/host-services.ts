import type {
  CreateSandboxProviderFactories,
  CreateSandboxProviderFactoriesInput,
} from "@sourceweft/builtin-tool-sandbox";
import { createCloudflareSandboxProviderFactory } from "./provider-factory";

/**
 * This capability's half of the `sandbox_provider` host-service contract.
 *
 * Every name read here is this provider's own (`CF_SANDBOX_*`), mirroring the
 * Daytona capability's pattern: the generic host never learns a vendor's env
 * var names.
 *
 * The factory is always returned even when unconfigured — readiness is
 * reported through `getConfigurationStatus()` so the operator sees
 * "CF_SANDBOX_BRIDGE_URL is missing" rather than "no provider registered for
 * 'cloudflare'".
 */
export const createSandboxProviderFactories: CreateSandboxProviderFactories = ({
  env,
  limits,
}: CreateSandboxProviderFactoriesInput) => [
  createCloudflareSandboxProviderFactory({
    bridgeUrl: stripTrailingSlash(env.get("CF_SANDBOX_BRIDGE_URL")?.trim() ?? ""),
    apiKey: env.get("CF_SANDBOX_API_KEY")?.trim() ?? "",
    maxOutputChars: limits.maxOutputChars,
  }),
];

function stripTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
