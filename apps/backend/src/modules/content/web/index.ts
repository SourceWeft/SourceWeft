import { config } from "../../../shared/config";
import { AnyCrawlWebProvider } from "./anycrawl-provider";
import type { WebProvider } from "./types";

export * from "./types";
export { AnyCrawlWebProvider } from "./anycrawl-provider";
export { validatePublicHttpUrl } from "./url-safety";

export function createDefaultWebProvider(): WebProvider | null {
  const apiKey = config.webProviders.anycrawl.apiKey;
  if (!apiKey) {
    return null;
  }
  return new AnyCrawlWebProvider(apiKey);
}
