import type {
  CreateSandboxProviderFactories,
  CreateSandboxProviderFactoriesInput,
} from "@sourceweft/builtin-tool-sandbox";
import { createDaytonaSandboxProviderFactory } from "./provider-factory";

/**
 * This capability's half of the `sandbox_provider` host-service contract.
 *
 * Every name read here is Daytona's own. The backend used to carry a
 * `config.sandbox.daytona.*` block and construct this factory by name, which
 * put a vendor's identity in the generic host: `DAYTONA_API_KEY` means nothing
 * to a substrate that is supposed to work with any provider.
 *
 * The env var names are unchanged, deliberately — only who reads them moved,
 * so no deployment has to be re-configured.
 *
 * A missing key does not make the provider disappear. Unlike the web provider,
 * whose absence is the host's normal "web tools unavailable" state, a sandbox
 * provider that vanished when unconfigured would be indistinguishable from one
 * that is not installed, and the operator would get "no provider registered
 * for 'daytona'" instead of "DAYTONA_API_KEY is missing". The factory is always
 * returned and reports its own readiness through `getConfigurationStatus()`.
 */
export const createSandboxProviderFactories: CreateSandboxProviderFactories = ({
  env,
  limits,
}: CreateSandboxProviderFactoriesInput) => [
  createDaytonaSandboxProviderFactory({
    apiUrl: stripTrailingSlash(env.get("DAYTONA_API_URL")?.trim() ?? ""),
    apiKey: env.get("DAYTONA_API_KEY")?.trim() ?? "",
    snapshot: env.get("DAYTONA_SANDBOX_SNAPSHOT")?.trim() ?? "",
    image: env.get("DAYTONA_SANDBOX_IMAGE")?.trim() ?? "",
    maxOutputChars: limits.maxOutputChars,
  }),
];

function stripTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
