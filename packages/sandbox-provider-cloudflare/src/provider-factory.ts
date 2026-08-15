import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";
import { CloudflareSandboxProvider } from "./cloudflare-provider";

export type CloudflareProviderFactoryConfig = {
  bridgeUrl: string;
  apiKey: string;
  maxOutputChars: number;
};

export function createCloudflareSandboxProviderFactory(
  factoryConfig: CloudflareProviderFactoryConfig,
): SandboxProviderFactory {
  return {
    id: "cloudflare",
    createProvider() {
      return new CloudflareSandboxProvider({
        bridgeUrl: factoryConfig.bridgeUrl,
        apiKey: factoryConfig.apiKey,
        maxOutputChars: factoryConfig.maxOutputChars,
      });
    },
    getConfigurationStatus() {
      const missing = [
        factoryConfig.bridgeUrl ? null : "CF_SANDBOX_BRIDGE_URL",
        factoryConfig.apiKey ? null : "CF_SANDBOX_API_KEY",
      ].filter((value): value is string => value !== null);

      return {
        configured: missing.length === 0,
        missing,
        metadata: {
          bridgeUrlConfigured: Boolean(factoryConfig.bridgeUrl),
          apiKeyConfigured: Boolean(factoryConfig.apiKey),
        },
      };
    },
  };
}
