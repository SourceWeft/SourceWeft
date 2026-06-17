import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";
import {
  DaytonaSandboxProvider,
  resolveDaytonaSandboxTarget,
} from "./daytona-provider";

export type DaytonaProviderFactoryConfig = {
  apiUrl: string;
  apiKey: string;
  snapshot?: string;
  image?: string;
  maxOutputChars: number;
};

function isSourceWeftDefaultSandboxTarget(value: string | undefined) {
  return Boolean(
    value &&
      (value.includes("sourceweft-sandbox") ||
        value.includes("sourceweft-runtime") ||
        value.includes("SourceWeft/sourceweft-sandbox")),
  );
}

export function createDaytonaSandboxProviderFactory(
  factoryConfig: DaytonaProviderFactoryConfig,
): SandboxProviderFactory {
  return {
    id: "daytona",
    createProvider() {
      return new DaytonaSandboxProvider({
        apiKey: factoryConfig.apiKey,
        apiUrl: factoryConfig.apiUrl,
        snapshot: factoryConfig.snapshot,
        image: factoryConfig.image,
        maxOutputChars: factoryConfig.maxOutputChars,
      });
    },
    getConfigurationStatus() {
      const targetStatus = resolveDaytonaSandboxTarget({
        snapshot: factoryConfig.snapshot,
        image: factoryConfig.image,
      });
      const missing = [
        factoryConfig.apiUrl ? null : "DAYTONA_API_URL",
        factoryConfig.apiKey ? null : "DAYTONA_API_KEY",
        ...targetStatus.missing,
      ].filter((value): value is string => value !== null);

      return {
        configured: missing.length === 0,
        missing,
        metadata: {
          apiUrlConfigured: Boolean(factoryConfig.apiUrl),
          apiKeyConfigured: Boolean(factoryConfig.apiKey),
          ...targetStatus.metadata,
          defaultSandboxEnvironmentAvailable:
            targetStatus.configured &&
            isSourceWeftDefaultSandboxTarget(targetStatus.target.value),
        },
      };
    },
  };
}
