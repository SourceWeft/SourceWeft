import type {
  CreateHostWebProvider,
  CreateHostWebProviderInput,
} from "@sourceweft/contracts/capability-host-services";
import { AnyCrawlWebProvider } from "./providers/anycrawl";

/**
 * This capability's half of the web-provider host-service contract.
 *
 * Which provider backs web search and fetch is this package's choice, and the
 * API key name is the provider's. The backend previously constructed
 * `AnyCrawlWebProvider` itself from a `webProviders.anycrawl` config key —
 * host code naming a vendor it has no opinion about.
 *
 * Returning null when the key is unset preserves the host's existing
 * behaviour: no provider means the web tools simply do not bind.
 */
export const createHostWebProvider: CreateHostWebProvider = ({
  env,
  fetchTimeoutMs,
}: CreateHostWebProviderInput) => {
  const apiKey = env.get("ANYCRAWL_API_KEY")?.trim();
  if (!apiKey) {
    return null;
  }
  return new AnyCrawlWebProvider(
    apiKey,
    fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs },
  );
};
