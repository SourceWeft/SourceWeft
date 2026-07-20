import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import {
  AnyCrawlWebProvider,
  type AnyCrawlWebProviderOptions,
} from "@sourceweft/builtin-tool-web-search/providers/anycrawl";
import { config } from "../../shared/config";

export function createDefaultWebProvider(
  options: AnyCrawlWebProviderOptions = {},
): AgentToolWebProvider | null {
  const apiKey = config.webProviders.anycrawl.apiKey;
  if (!apiKey) {
    return null;
  }
  return new AnyCrawlWebProvider(apiKey, options);
}
