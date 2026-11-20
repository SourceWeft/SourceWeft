import type { ThinkingConfig } from "@sourceweft/model-gateway";
import type { EmbeddingIndexIdentity } from "../../../shared/model-gateway/embedding-identity";
import type { RoutedGatewayConfig } from "../../../shared/model-gateway/types";

/**
 * The production DeepInfra chat route, rebuilt for the data table evaluation
 * (`scripts/eval-table.ts --chat-target deepinfra`) without reading any
 * profile, gateway or pricing row: the evaluation runs on the host production
 * uses, while the local deployment's own default may be another.
 *
 * Copied from the production gateway configuration (`model-gateway.saas.json`
 * as mounted 2026-11-15, unchanged by later releases as far as recorded):
 * - gateway `deepinfra-default`: kind `deepinfra`, base URL
 *   `https://api.deepinfra.com/v1`, credential `DEEPINFRA_API_KEY`, timeout
 *   30 s, 2 retries, `supports` without `json_schema` / `json_schema_strict`;
 * - `chat-default` priority-2 target `deepseek-ai/DeepSeek-V4.1-Flash-1017`
 *   (the priority-3 OpenRouter target is a selection candidate, not a
 *   failover, and is left out: a DeepInfra failure fails the call);
 * - `chat-default` thinking support `reasoning_effort` with efforts
 *   minimal…high, which the billed gateway fills into a "thinking off" call, so
 *   the DeepInfra adapter sends `reasoning_effort: "none"`;
 * - `embed-default` priority-1 target `BAAI/bge-m3` at 1024 dimensions, for
 *   the by-meaning anchoring pass.
 *
 * `structuredOutput: "strict"` adds `json_schema_strict` to the provider's
 * `supports`, which production does not declare; it is an explicit choice,
 * never a default.
 */

export type StructuredOutputChoice = "as-production" | "strict";

const PRODUCTION_SUPPORTS = ["chat", "embeddings", "rerank", "asr", "tts", "image"];
const CHAT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const EMBEDDING_MODEL = "BAAI/bge-m3";

export type DeepInfraEvalTarget = {
  routed: RoutedGatewayConfig;
  chat: {
    profileAlias: string;
    modelAlias: string;
    providerModel: string;
    thinking: ThinkingConfig;
  };
  embedding: {
    profileAlias: string;
    providerModel: string;
    requestedDimensions: number;
    identity: EmbeddingIndexIdentity;
  };
};

export function buildDeepInfraEvalTarget(input: {
  apiKey: string | undefined;
  structuredOutput: StructuredOutputChoice;
}): DeepInfraEvalTarget {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "--chat-target deepinfra needs DEEPINFRA_API_KEY in the environment; the default profile is never used instead",
    );
  }
  const supports =
    input.structuredOutput === "strict"
      ? [...PRODUCTION_SUPPORTS, "json_schema_strict"]
      : [...PRODUCTION_SUPPORTS];
  return {
    routed: {
      versionId: `eval-table-deepinfra-${input.structuredOutput}`,
      providers: {
        deepinfra: {
          gatewayConfigId: null,
          kind: "deepinfra",
          baseUrl: "https://api.deepinfra.com/v1",
          apiKey,
          isBYOK: false,
          enabled: true,
          configured: true,
          globalReady: true,
          requiresGlobalApiKey: true,
          hasGlobalApiKey: true,
          defaultHeaders: {},
          supports,
          timeoutMs: 30_000,
          maxRetries: 2,
        },
      },
      modelRoutes: {
        "chat-default": {
          strategy: "priority",
          targets: [{ provider: "deepinfra", model: CHAT_MODEL, priority: 2, weight: 0 }],
        },
        "embed-default": {
          strategy: "priority",
          targets: [{ provider: "deepinfra", model: EMBEDDING_MODEL, priority: 1, weight: 100 }],
        },
      },
    },
    chat: {
      profileAlias: "chat-default",
      modelAlias: "chat-default",
      providerModel: CHAT_MODEL,
      thinking: {
        mode: "off",
        enabled: false,
        includeReasoning: false,
        supportedParameters: ["reasoning_effort"],
        supportedEfforts: ["minimal", "low", "medium", "high"],
      },
    },
    embedding: {
      profileAlias: "embed-default",
      providerModel: EMBEDDING_MODEL,
      requestedDimensions: 1024,
      identity: {
        version: 2,
        revision: "eval-table-deepinfra",
        profileId: "global:embedding:bge-m3-1024",
        profileAlias: "embed-default",
        // canonicalProviderModel("BAAI/bge-m3")
        canonicalModel: "bge-m3",
        requestedDimensions: 1024,
      },
    },
  };
}
