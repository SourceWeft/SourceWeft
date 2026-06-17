import type { WebProvider } from "@sourceweft/builtin-tool-web-search";
import {
  AnyCrawlWebProvider,
  type AnyCrawlWebProviderOptions,
} from "@sourceweft/builtin-tool-web-search/providers/anycrawl";
import { config } from "../../shared/config";

export function createDefaultWebProvider(
  options: AnyCrawlWebProviderOptions = {},
): WebProvider | null {
  const apiKey = config.webProviders.anycrawl.apiKey;
  if (!apiKey) {
    return null;
  }
  return new AnyCrawlWebProvider(apiKey, options);
}
