import type { AIMessageChunk } from "@langchain/core/messages";
import type {
  GatewayErrorCode,
  GatewayErrorData,
  GatewayProviderConfig,
  ModelGatewayConfig,
  ModelRouteConfig,
} from "../../src/index";
import { ModelGatewayError } from "../../src/index";

export const OPENROUTER_CHAT_MODEL = "minimax/minimax-m2.7";
export const OPENROUTER_RERANK_MODEL = "cohere/rerank-4-pro";
export const DEEPINFRA_EMBED_MODEL = "BAAI/bge-m3";

export interface ProviderEnvConfig {
  apiKey: string;
  baseUrl: string;
}

export interface IntegrationEnvConfig {
  openrouter: ProviderEnvConfig | null;
  deepinfra: ProviderEnvConfig | null;
}

export class IntegrationTestSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationTestSkipError";
  }
}

export function readIntegrationEnv(): IntegrationEnvConfig {
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  const deepinfraApiKey = process.env.DEEPINFRA_API_KEY?.trim();

  return {
    openrouter: openrouterApiKey
      ? {
          apiKey: openrouterApiKey,
          baseUrl: process.env.OPENROUTER_API_BASE?.trim() || "https://openrouter.ai/api/v1",
        }
      : null,
    deepinfra: deepinfraApiKey
      ? {
          apiKey: deepinfraApiKey,
          baseUrl:
            process.env.DEEPINFRA_API_BASE?.trim() ||
            "https://api.deepinfra.com/v1/openai",
        }
      : null,
  };
}

export function requireProvider(
  config: ProviderEnvConfig | null,
  name: string,
): ProviderEnvConfig {
  if (!config) {
    throw new IntegrationTestSkipError(
      `Skipping integration test because ${name} env is not configured`,
    );
  }

  return config;
}

export function createProviderConfig(input: {
  kind: GatewayProviderConfig["kind"];
  baseUrl: string;
  apiKey: string;
}): GatewayProviderConfig {
  return {
    kind: input.kind,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  };
}

export function createPriorityRoute(input: {
  provider: string;
  model: string;
}): ModelRouteConfig {
  return {
    strategy: "priority",
    targets: [{ provider: input.provider, model: input.model, priority: 1 }],
  };
}

export function createIntegrationGatewayConfig(input: {
  aliases: readonly string[];
  providers: ModelGatewayConfig["providers"];
  routes: ModelGatewayConfig["modelRoutes"];
}): ModelGatewayConfig {
  return {
    allowedModelAliases: input.aliases,
    providers: input.providers,
    modelRoutes: input.routes,
  };
}

export function shouldSkipIntegrationError(error: unknown): boolean {
  return error instanceof IntegrationTestSkipError;
}

export function createMockGatewayError(input: {
  code: GatewayErrorCode;
  message: string;
  retryable?: boolean;
  statusCode?: number;
  provider?: string;
  requestId?: string;
}): ModelGatewayError {
  return new ModelGatewayError(input);
}

export function collectStreamText(
  events: Array<{ type: string; chunk?: AIMessageChunk }>,
): string {
  return events
    .filter((event) => event.type === "chunk")
    .map((event) => {
      const chunk = event.chunk;
      if (!chunk || typeof chunk !== "object") {
        return "";
      }
      const content = (chunk as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .join("");
}

export function assertGatewayErrorShape(
  error: GatewayErrorData,
  expected: Partial<GatewayErrorData>,
) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = error[key as keyof GatewayErrorData];
    if (value !== undefined && actual !== value) {
      throw new Error(
        `Expected gateway error field '${key}' to equal '${String(value)}', got '${String(actual)}'`,
      );
    }
  }
}
