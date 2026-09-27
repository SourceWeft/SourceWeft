import {
  createModelGateway,
  hasConfiguredCredentialHeaders,
  ModelGatewayError,
  TargetHealthRegistry,
  type ChatCompleteInput,
  type ChatCompleteResult,
  type ModelGateway,
} from "@sourceweft/model-gateway";
import { config } from "../config";
import { logger } from "../logger";
import {
  buildRoutedModelGatewayConfig,
  loadRoutedGatewayConfig,
} from "./runtime";
import { resolveChatThinkingWithDefaults } from "./thinking-defaults";
import type { RoutedGatewayConfig } from "./types";

/**
 * The system model: the one door for model calls the platform makes on its
 * own behalf — market overviews and MCP classification — which belong to no
 * tenant.
 *
 * It adds no Provider support of its own. It borrows the non-secret
 * definition of a Provider from the active global gateway configuration
 * (`SYSTEM_MODEL_PROVIDER`), gives it the dedicated `SYSTEM_MODEL_API_KEY`,
 * and routes `SYSTEM_MODEL_NAME` through the same chain tenant calls use:
 * `loadRoutedGatewayConfig` → `buildRoutedModelGatewayConfig` →
 * `createModelGateway`, so the endpoint policy, capability rules, timeouts,
 * retries and adapters are the same code. Like BYOK, it never reuses that
 * Provider's global key or global activation: a Provider disabled for GLOBAL
 * traffic can still lend its definition, and a missing dedicated key is a
 * reason not to run, never a cue to use another key or another model.
 *
 * Nothing here is billed: no tenant admission, no `usage_ledgers` rows, no
 * `llm_generations` rows, and nothing is written to the database. Each call
 * emits exactly one `system_model.call` log line instead — never with the
 * prompt, the output or the key. Only the market modules may import
 * `withSystemModel`; `architecture.test.ts` enforces that.
 */

export const SYSTEM_MODEL_PURPOSES = [
  "skill_market.overview",
  "skill_market.evaluation",
  "mcp_market.classify",
  "mcp_market.overview",
] as const;

export type SystemModelPurpose = (typeof SYSTEM_MODEL_PURPOSES)[number];

// The in-memory route the system gateway is built from. It is never written to
// the database, so it cannot reach the user catalog.
export const SYSTEM_MODEL_ROUTE = "system:market";

// Platform work is batch work: a long structured answer is normal, and a
// failed call is retried by its job anyway.
export const SYSTEM_MODEL_TIMEOUT_MS = 120_000;
export const SYSTEM_MODEL_MAX_RETRIES = 2;

// What a Provider must declare to serve structured platform calls.
const REQUIRED_SUPPORTS = ["chat", "json_schema"] as const;

export type SystemModelSettings = {
  enabled: boolean;
  provider: string;
  apiKey: string;
  model: string;
};

export type SystemModelProblem =
  | "disabled"
  | "provider_unset"
  | "api_key_unset"
  | "model_unset"
  | "gateway_config_unavailable"
  | "provider_not_found"
  | "provider_capability_missing"
  | "provider_credential_headers";

export type SystemModelReadiness = {
  /** SYSTEM_MODEL_ENABLED. */
  enabled: boolean;
  /**
   * The Provider definition exists, supports chat + json_schema and carries
   * no credentials of its own, and the key and model are set.
   */
  configured: boolean;
  ready: boolean;
  provider: string | null;
  model: string | null;
  problems: SystemModelProblem[];
  /** What exactly is missing, for logs and errors; null when ready. Names settings, never values. */
  reason: string | null;
};

/** Thrown instead of calling any model when the system model is not ready. */
export class SystemModelUnavailableError extends Error {
  readonly code = "SYSTEM_MODEL_NOT_READY";

  constructor(readonly readiness: SystemModelReadiness) {
    super(`System model is not ready: ${readiness.reason ?? "unknown"}`);
    this.name = "SystemModelUnavailableError";
  }
}

function currentSettings(): SystemModelSettings {
  return config.systemModel;
}

function problemMessage(
  problem: SystemModelProblem,
  settings: SystemModelSettings,
  missingSupports: readonly string[],
): string {
  switch (problem) {
    case "disabled":
      return "SYSTEM_MODEL_ENABLED is not true";
    case "provider_unset":
      return "SYSTEM_MODEL_PROVIDER is not set";
    case "api_key_unset":
      return "SYSTEM_MODEL_API_KEY is not set";
    case "model_unset":
      return "SYSTEM_MODEL_NAME is not set";
    case "gateway_config_unavailable":
      return "the global model gateway configuration is not synchronized";
    case "provider_not_found":
      return `Provider '${settings.provider}' is not in the active global model gateway configuration`;
    case "provider_capability_missing":
      return `Provider '${settings.provider}' does not declare support for ${missingSupports.join(", ")}`;
    case "provider_credential_headers":
      return `Provider '${settings.provider}' sends credential headers of its own, which the system model does not reuse`;
  }
}

/**
 * Readiness from the settings and the active routed configuration. Pure: the
 * key's presence counts, its value is never looked at.
 */
export function evaluateSystemModelReadiness(
  settings: SystemModelSettings,
  routed: RoutedGatewayConfig | null,
): SystemModelReadiness {
  const problems: SystemModelProblem[] = [];
  let missingSupports: string[] = [];
  if (!settings.enabled) problems.push("disabled");
  if (!settings.provider) {
    problems.push("provider_unset");
  } else if (!routed) {
    problems.push("gateway_config_unavailable");
  } else {
    const provider = routed.providers[settings.provider];
    if (!provider) {
      problems.push("provider_not_found");
    } else {
      missingSupports = REQUIRED_SUPPORTS.filter(
        (capability) => !provider.supports.includes(capability),
      );
      if (missingSupports.length > 0)
        problems.push("provider_capability_missing");
      // A credential baked into the definition's headers is a global key in
      // all but name; like BYOK, the system model refuses to borrow it.
      if (hasConfiguredCredentialHeaders(provider))
        problems.push("provider_credential_headers");
    }
  }
  if (!settings.apiKey) problems.push("api_key_unset");
  if (!settings.model) problems.push("model_unset");

  const enabled = settings.enabled;
  const configured = problems.every((problem) => problem === "disabled");
  return {
    enabled,
    configured,
    ready: enabled && configured,
    provider: settings.provider || null,
    model: settings.model || null,
    problems,
    reason:
      problems.length > 0
        ? problems
            .map((problem) =>
              problemMessage(problem, settings, missingSupports),
            )
            .join("; ")
        : null,
  };
}

/** Readiness against the active configuration, for the admin UI and jobs. */
export async function getSystemModelReadiness(): Promise<SystemModelReadiness> {
  return evaluateSystemModelReadiness(
    currentSettings(),
    await loadRoutedGatewayConfig(),
  );
}

export type SystemModelIdentity = {
  provider: string;
  kind: string;
  /** Origin and path only: credentials and query strings never enter it. */
  baseUrl: string;
  apiVersion: string | null;
  model: string;
};

/**
 * The non-secret identity of the configured system model, for keys that must
 * change when the model or its endpoint does (analysis caching, quality
 * gating) and stay put when only the credential rotates. Null while it is not
 * configured; a configured model that is merely switched off keeps its
 * identity.
 */
export async function resolveSystemModelIdentity(): Promise<SystemModelIdentity | null> {
  const settings = currentSettings();
  const routed = await loadRoutedGatewayConfig();
  const readiness = evaluateSystemModelReadiness(settings, routed);
  const provider = routed?.providers[settings.provider];
  if (!readiness.configured || !provider) return null;
  const url = new URL(provider.baseUrl);
  return {
    provider: settings.provider,
    kind: provider.kind,
    baseUrl: `${url.origin}${url.pathname}`,
    apiVersion: url.searchParams.get("api-version"),
    model: settings.model,
  };
}

/**
 * The in-memory configuration the system gateway is built from: a copy of the
 * borrowed definition carrying the dedicated key, and one route to the
 * configured model. Only this Provider is in it, so no global key is even
 * present for a request to fall back to. Enablement comes from our readiness,
 * never from the borrowed Provider's global state.
 *
 * The copy keeps the borrowed Provider's name: the gateway looks up
 * Provider-specific request and response handling by name (OpenRouter's
 * inline cost, OrcaRouter's request decoration), and that must apply here
 * exactly as it does for tenant calls. The global entry is not in this
 * configuration, and this client is not the tenant one, so nothing confuses
 * the two.
 */
export function buildSystemModelRoutedConfig(
  routed: RoutedGatewayConfig,
  settings: SystemModelSettings,
  readiness: SystemModelReadiness,
): RoutedGatewayConfig {
  const borrowed = routed.providers[settings.provider];
  if (!readiness.ready || !borrowed) {
    throw new SystemModelUnavailableError(readiness);
  }
  return {
    versionId: routed.versionId,
    providers: {
      [settings.provider]: {
        gatewayConfigId: borrowed.gatewayConfigId,
        kind: borrowed.kind,
        baseUrl: borrowed.baseUrl,
        apiKey: settings.apiKey,
        apiKeyHeaderName: borrowed.apiKeyHeaderName,
        apiKeyHeaderPrefix: borrowed.apiKeyHeaderPrefix,
        isBYOK: false,
        enabled: readiness.enabled,
        configured: readiness.configured,
        globalReady: readiness.ready,
        requiresGlobalApiKey: true,
        hasGlobalApiKey: true,
        defaultHeaders: { ...borrowed.defaultHeaders },
        supports: [...borrowed.supports],
        timeoutMs: SYSTEM_MODEL_TIMEOUT_MS,
        maxRetries: SYSTEM_MODEL_MAX_RETRIES,
      },
    },
    modelRoutes: {
      [SYSTEM_MODEL_ROUTE]: {
        strategy: "priority",
        targets: [
          {
            provider: settings.provider,
            model: settings.model,
            priority: 1,
            weight: 100,
          },
        ],
      },
    },
    modelCapabilities: routed.modelCapabilities,
  };
}

// One client at a time: keyed by configuration version, Provider and model,
// never by the key. A new gateway configuration version rebuilds it; a new key
// takes an env change and a restart.
let cachedClient: { cacheKey: string; client: ModelGateway } | null = null;

// Target health is in effect per credential: failures of the dedicated key (an
// exhausted budget, say) must not demote the same target for tenant calls,
// whose health lives in the gateway's shared default registry.
const systemTargetHealth = new TargetHealthRegistry();

function systemModelClient(
  routed: RoutedGatewayConfig,
  settings: SystemModelSettings,
  readiness: SystemModelReadiness,
): ModelGateway {
  const cacheKey = JSON.stringify([
    routed.versionId,
    settings.provider,
    settings.model,
  ]);
  if (cachedClient?.cacheKey === cacheKey) return cachedClient.client;
  const client = createModelGateway({
    ...buildRoutedModelGatewayConfig(
      buildSystemModelRoutedConfig(routed, settings, readiness),
      // Platform calls are not tenant generations: nothing is persisted, and
      // the one log line below is their record.
      { observeSink: null, byok: false },
    ),
    targetHealth: systemTargetHealth,
  });
  cachedClient = { cacheKey, client };
  return client;
}

export type SystemModelCallContext = {
  purpose: SystemModelPurpose;
  /** What the call is about, e.g. `skill-version:<id>`. Logged; never content. */
  subjectRef: string;
  /** The unit of work the call belongs to (one job try). Logged, and the trace id. */
  scopeId: string;
};

/** A chat request; the system model decides the route, mode and credential. */
export type SystemChatCompleteInput = Omit<
  ChatCompleteInput,
  | "model"
  | "profileAlias"
  | "executionMode"
  | "providerHint"
  | "fallbackPolicy"
  | "byok"
  | "byokModelId"
  | "credentialId"
  | "metadata"
>;

export type SystemModelChat = {
  complete(
    input: SystemChatCompleteInput,
    options?: { signal?: AbortSignal },
  ): Promise<ChatCompleteResult>;
};

function errorCodeOf(error: unknown): string {
  return ModelGatewayError.isInstance(error) ? error.code : "UNKNOWN";
}

function tokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function logCall(input: {
  context: SystemModelCallContext;
  settings: SystemModelSettings;
  startedAt: number;
  result?: ChatCompleteResult;
  error?: unknown;
}) {
  const usage = input.result?.observation?.usage ?? input.result?.usage;
  const cost = input.result?.observation?.cost;
  const reportedCost =
    cost?.source === "provider_inline" &&
    typeof cost.inlineUsd === "number" &&
    Number.isFinite(cost.inlineUsd)
      ? cost.inlineUsd
      : undefined;
  logger.info("system_model.call", {
    purpose: input.context.purpose,
    subjectRef: input.context.subjectRef,
    scopeId: input.context.scopeId,
    provider: input.settings.provider,
    model: input.settings.model,
    status: input.error === undefined ? "ok" : "error",
    errorCode: input.error === undefined ? null : errorCodeOf(input.error),
    durationMs: Date.now() - input.startedAt,
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    ...(reportedCost !== undefined ? { costUsd: reportedCost } : {}),
  });
}

/**
 * Fills the thinking-support facts the adapter needs to honour a thinking
 * intent (e.g. `off`), from the borrowed Provider's catalog entry for this
 * model — the same lookup the billed door uses. Unknown facts leave the
 * intent inert, as they do there; this says so rather than staying silent.
 */
async function resolveThinking(
  input: SystemChatCompleteInput,
  context: SystemModelCallContext,
  settings: SystemModelSettings,
  gatewayConfigId: string | null,
) {
  if (!input.thinking) return input.thinking;
  let thinking = input.thinking;
  try {
    thinking =
      (await resolveChatThinkingWithDefaults({
        thinking: input.thinking,
        modelAlias: settings.model,
        ...(gatewayConfigId ? { gatewayConfigId } : {}),
      })) ?? input.thinking;
  } catch (error) {
    logger.warn("system_model.thinking_support_lookup_failed", {
      purpose: context.purpose,
      provider: settings.provider,
      model: settings.model,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (thinking.supportedParameters === undefined) {
    logger.warn("system_model.thinking_support_unknown", {
      purpose: context.purpose,
      provider: settings.provider,
      model: settings.model,
    });
  }
  return thinking;
}

/**
 * Runs `run` against the system model. Throws SystemModelUnavailableError —
 * before any model is reached — when it is not ready.
 */
export async function withSystemModel<T>(
  context: SystemModelCallContext,
  run: (chat: SystemModelChat) => Promise<T>,
): Promise<T> {
  if (!(SYSTEM_MODEL_PURPOSES as readonly string[]).includes(context.purpose)) {
    throw new Error(
      `Unknown system model purpose '${String(context.purpose)}'`,
    );
  }
  const settings = currentSettings();
  const routed = await loadRoutedGatewayConfig();
  const readiness = evaluateSystemModelReadiness(settings, routed);
  if (!readiness.ready || !routed) {
    throw new SystemModelUnavailableError(readiness);
  }
  const client = systemModelClient(routed, settings, readiness);
  const gatewayConfigId =
    routed.providers[settings.provider]?.gatewayConfigId ?? null;

  const chat: SystemModelChat = {
    complete: async (input, options) => {
      const startedAt = Date.now();
      let result: ChatCompleteResult;
      try {
        const request = withoutRoutingFields(input);
        const thinking = await resolveThinking(
          request,
          context,
          settings,
          gatewayConfigId,
        );
        result = await client.chat.complete(
          {
            ...request,
            ...(thinking ? { thinking } : {}),
            model: SYSTEM_MODEL_ROUTE,
            executionMode: "GLOBAL",
            fallbackPolicy: "none",
          },
          {
            traceId: context.scopeId,
            ...(options?.signal ? { signal: options.signal } : {}),
          },
        );
      } catch (error) {
        logCall({ context, settings, startedAt, error });
        throw error;
      }
      logCall({ context, settings, startedAt, result });
      return result;
    },
  };
  return run(chat);
}

const ROUTING_FIELDS = [
  "model",
  "profileAlias",
  "executionMode",
  "providerHint",
  "fallbackPolicy",
  "byok",
  "byokModelId",
  "credentialId",
  "metadata",
] as const satisfies ReadonlyArray<keyof ChatCompleteInput>;

/**
 * Drops routing and credential fields even if a cast smuggled them in: the
 * system route, GLOBAL mode and the dedicated key are the only ones this door
 * serves.
 */
function withoutRoutingFields(
  input: SystemChatCompleteInput,
): SystemChatCompleteInput {
  const request: Partial<ChatCompleteInput> = { ...input };
  for (const field of ROUTING_FIELDS) delete request[field];
  return request as SystemChatCompleteInput;
}
