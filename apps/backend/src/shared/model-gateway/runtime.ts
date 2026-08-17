import {
  createModelGateway,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type ModelCapabilityRule,
  type ModelGateway,
  type ModelGatewayConfig,
  type ProviderRoutingConfig,
} from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { config } from "../config";
import {
  db,
  modelGatewayByokCredentials,
  modelGatewayConfigs,
  modelGatewayConfigVersions,
  modelGatewayProviderConfigs,
  modelGatewayRoutes,
  type ModelGatewayProviderKind,
} from "@sourceweft/db";
import { createLlmObservabilitySink } from "../../modules/llm-observability/sink";
import { resolveObservedGenerationCost } from "./observed-cost";
import { decryptSecret } from "../secrets";
import type { RoutedGatewayConfig } from "./types";
import { MODEL_CAPABILITY_DB } from "./model-capability-db";
import { resolveCustomByokProvider } from "./byok-provider-resolver";

import { OPENROUTER_APP_TITLE } from "./attribution";

type ActiveConfigVersionRow = typeof modelGatewayConfigVersions.$inferSelect;

const gatewayClientCache = new Map<
  string,
  {
    signature: string;
    client: ModelGateway;
  }
>();

export function normalizeDefaultHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, headerValue]) => [key.trim(), headerValue.trim()] as const)
      .filter(([key, headerValue]) => key.length > 0 && headerValue.length > 0),
  );
}

export function withOpenRouterAttributionHeaders(input: {
  providerKind: ModelGatewayProviderKind;
  defaultHeaders?: Record<string, string>;
}) {
  const headers = {
    ...(input.defaultHeaders ?? {}),
  };

  if (input.providerKind !== "openrouter") {
    return headers;
  }

  return {
    ...headers,
    "HTTP-Referer": config.openrouterAppReferer,
    "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
    "X-Title": OPENROUTER_APP_TITLE,
  };
}

export function normalizeRouteProviderRouting(
  value: unknown,
): ProviderRoutingConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const providerRouting = record.providerRouting;
  if (!providerRouting || typeof providerRouting !== "object" || Array.isArray(providerRouting)) {
    return undefined;
  }

  return providerRouting as ProviderRoutingConfig;
}

function normalizeOptionalHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

export async function resolveByokApiKeyRef(input: {
  provider: string;
  apiKeyRef: string;
  metadata?: Record<string, unknown>;
}) {
  const workspaceId =
    typeof input.metadata?.workspace_id === "string"
      ? input.metadata.workspace_id
      : undefined;
  const teamId =
    typeof input.metadata?.team_id === "string"
      ? input.metadata.team_id
      : undefined;
  const userId =
    typeof input.metadata?.user_id === "string"
      ? input.metadata.user_id
      : undefined;

  if (!workspaceId || !teamId) {
    return null;
  }

  const rows = await db
    .select()
    .from(modelGatewayByokCredentials)
    .where(
      and(
        eq(modelGatewayByokCredentials.workspaceId, workspaceId),
        eq(modelGatewayByokCredentials.teamId, teamId),
        eq(modelGatewayByokCredentials.providerName, input.provider),
        eq(modelGatewayByokCredentials.credentialAlias, input.apiKeyRef),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    );

  const row = rows.find((candidate) => {
    if (!candidate.userId) {
      return true;
    }
    return userId ? candidate.userId === userId : false;
  });

  if (!row) {
    return null;
  }

  return (
    decryptSecret(row.apiKeyEncrypted, config.modelGatewayEncryptionSecret) ||
    null
  );
}

export async function resolveByokProviderRuntime(input: {
  provider: string;
  apiKeyRef?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const activeConfig = await loadRoutedGatewayConfig();
  const systemProvider = activeConfig?.providers[input.provider] ?? null;

  const customProvider = systemProvider
    ? null
    : await resolveCustomByokProvider({
        providerName: input.provider,
        apiKeyRef: input.apiKeyRef,
        metadata: input.metadata,
      });

  if (customProvider) {
    return {
      source: "custom" as const,
      providerName: customProvider.providerName,
      providerKind: customProvider.providerKind,
      baseUrl: customProvider.baseUrl,
      apiKey: customProvider.apiKey,
      defaultHeaders: customProvider.defaultHeaders,
      hasUserScopedKey: customProvider.hasUserScopedKey,
    };
  }

  if (!systemProvider) {
    return null;
  }

  return {
    source: "system" as const,
    providerName: input.provider,
    providerKind: systemProvider.kind,
    baseUrl: systemProvider.baseUrl,
    apiKey: systemProvider.apiKey ?? null,
    defaultHeaders: systemProvider.defaultHeaders,
    hasUserScopedKey: false,
  };
}

export async function findActiveConfigVersionRow(): Promise<ActiveConfigVersionRow | null> {
  const [row] = await db
    .select()
    .from(modelGatewayConfigVersions)
    .where(eq(modelGatewayConfigVersions.isActive, true))
    .limit(1);

  return row ?? null;
}

export async function loadRoutedGatewayConfig(): Promise<RoutedGatewayConfig | null> {
  const activeVersion = await findActiveConfigVersionRow();
  if (!activeVersion) {
    return null;
  }

  const providerRows = await db
    .select()
    .from(modelGatewayProviderConfigs)
    .where(
      and(
        eq(modelGatewayProviderConfigs.configVersionId, activeVersion.id),
        eq(modelGatewayProviderConfigs.isActive, true),
      ),
    );

  const routeRows = await db
    .select()
    .from(modelGatewayRoutes)
    .where(
      and(
        eq(modelGatewayRoutes.configVersionId, activeVersion.id),
        eq(modelGatewayRoutes.isActive, true),
      ),
    );

  if (providerRows.length === 0 || routeRows.length === 0) {
    return null;
  }

  const gatewayIds = Array.from(
    new Set(
      providerRows
        .map((row) => row.gatewayConfigId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );

  const gatewayRows = gatewayIds.length
    ? (await db.select().from(modelGatewayConfigs)).filter((row) =>
        row.isActive && gatewayIds.includes(row.id),
      )
    : [];
  const gatewayRowById = new Map(gatewayRows.map((row) => [row.id, row]));

  const providers: RoutedGatewayConfig["providers"] = {};
  for (const row of providerRows) {
    const gatewayRow = row.gatewayConfigId ? gatewayRowById.get(row.gatewayConfigId) : null;
    const supports = Array.isArray(row.capabilitiesJson)
      ? row.capabilitiesJson.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const providerConfigJson =
      row.configJson && typeof row.configJson === "object"
        ? (row.configJson as Record<string, unknown>)
        : {};

    providers[row.providerName] = {
      gatewayConfigId: row.gatewayConfigId,
      kind: row.providerKind,
      baseUrl: row.baseUrl,
      apiKey:
        gatewayRow && gatewayRow.apiKeyEncrypted
          ? decryptSecret(
              gatewayRow.apiKeyEncrypted,
              config.modelGatewayEncryptionSecret,
            ) || undefined
          : undefined,
      apiKeyHeaderName: normalizeOptionalHeaderValue(
        providerConfigJson.apiKeyHeaderName,
      ),
      apiKeyHeaderPrefix: typeof providerConfigJson.apiKeyHeaderPrefix === "string"
        ? providerConfigJson.apiKeyHeaderPrefix
        : undefined,
      isBYOK: gatewayRow?.isBYOK ?? false,
      hasGlobalApiKey:
        typeof gatewayRow?.apiKeyEncrypted === "string" &&
        gatewayRow.apiKeyEncrypted.length > 0,
      defaultHeaders: withOpenRouterAttributionHeaders({
        providerKind: row.providerKind,
        defaultHeaders: normalizeDefaultHeaders(
          providerConfigJson.defaultHeaders,
        ),
      }),
      supports,
      timeoutMs: resolveModelGatewayTimeoutMs(gatewayRow?.timeoutMs),
      maxRetries: resolveModelGatewayMaxRetries(gatewayRow?.maxRetries),
    };
  }

  const modelRoutes: RoutedGatewayConfig["modelRoutes"] = {};
  for (const row of routeRows) {
    const existing = modelRoutes[row.alias] ?? {
      strategy: row.strategy,
      targets: [],
    };
    const providerRouting = normalizeRouteProviderRouting(row.constraintsJson);
    existing.targets.push({
      provider: row.targetProviderName,
      model: row.targetModel,
      priority: row.priority,
      weight: row.weight,
      ...(providerRouting ? { providerRouting } : {}),
    });
    modelRoutes[row.alias] = existing;
  }

  return {
    versionId: activeVersion.id,
    providers,
    modelRoutes,
    modelCapabilities: readDeploymentModelCapabilities(activeVersion.payloadJson),
  };
}

/**
 * Deployment-declared capability rules from the stored config payload. Read
 * leniently (skipping malformed entries) — global-config already validated them
 * at sync time; a stored config should not fail the runtime load.
 */
function readDeploymentModelCapabilities(
  payloadJson: unknown,
): ModelCapabilityRule[] {
  if (!payloadJson || typeof payloadJson !== "object") {
    return [];
  }
  const raw = (payloadJson as Record<string, unknown>).modelCapabilities;
  if (!Array.isArray(raw)) {
    return [];
  }
  const rules: ModelCapabilityRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const modelMatch = record.modelMatch;
    const capabilities =
      record.capabilities && typeof record.capabilities === "object"
        ? (record.capabilities as Record<string, unknown>)
        : {};
    if (typeof modelMatch !== "string" || modelMatch.trim().length === 0) {
      continue;
    }
    const disabledParams = readDisabledParams(capabilities.disabledParams);
    rules.push({
      modelMatch,
      capabilities: {
        ...(disabledParams ? { disabledParams } : {}),
        ...(typeof capabilities.toolCallArgumentJsonRepair === "boolean"
          ? {
              toolCallArgumentJsonRepair:
                capabilities.toolCallArgumentJsonRepair,
            }
          : {}),
        ...(capabilities.structuredOutputMethod === "json_schema" ||
        capabilities.structuredOutputMethod === "json_mode" ||
        capabilities.structuredOutputMethod === "function_calling"
          ? { structuredOutputMethod: capabilities.structuredOutputMethod }
          : {}),
      },
    });
  }
  return rules;
}

/**
 * Parse a disabled_params map (langchain-python `disabled_params` mirror): each
 * value is `null` (drop the param entirely) or an array (drop only those
 * values). Malformed values are skipped; returns undefined when nothing valid.
 */
function readDisabledParams(
  raw: unknown,
): Record<string, null | readonly unknown[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, null | readonly unknown[]> = {};
  for (const [param, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || Array.isArray(value)) {
      out[param] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function getRoutedGatewayCacheSignature(config: RoutedGatewayConfig) {
  return JSON.stringify(config);
}

function hasGatewayConfig(
  routedConfig: RoutedGatewayConfig,
  gatewayConfigId: string,
) {
  return Object.values(routedConfig.providers).some(
    (provider) => provider.gatewayConfigId === gatewayConfigId,
  );
}

export function assertGatewayConfigAvailable(
  routedConfig: RoutedGatewayConfig,
  gatewayConfigId?: string | null,
) {
  if (!gatewayConfigId) {
    return;
  }

  if (!hasGatewayConfig(routedConfig, gatewayConfigId)) {
    throw new Error(
      `Gateway config '${gatewayConfigId}' is not available in the active model gateway version`,
    );
  }
}

export function buildRoutedModelGatewayConfig(
  configInput: RoutedGatewayConfig,
): ModelGatewayConfig {
  return {
    providers: Object.fromEntries(
      Object.entries(configInput.providers).map(([name, provider]) => [
        name,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiKeyHeaderName: provider.apiKeyHeaderName,
          apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
          defaultHeaders: provider.defaultHeaders,
          supports: provider.supports,
          // Carried per provider so one slow gateway cannot widen every other
          // provider's timeout (previously hoisted via Math.max).
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
        },
      ]),
    ),
    modelRoutes: configInput.modelRoutes,
    // Deployment overrides first, then the code-shipped DB — merged here at
    // runtime so a DB change applies on redeploy without re-syncing the config.
    modelCapabilities: [
      ...(configInput.modelCapabilities ?? []),
      ...MODEL_CAPABILITY_DB,
    ],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    allowNonDefaultAliases: false,
    resolveApiKeyRef: resolveByokApiKeyRef,
    resolveCustomByokProvider: async (input) => {
      const provider = await resolveByokProviderRuntime({
        provider: input.provider,
        apiKeyRef: input.apiKeyRef,
        metadata: input.metadata,
      });

      if (!provider) {
        return null;
      }

      return {
        kind: provider.providerKind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? undefined,
        defaultHeaders: provider.defaultHeaders,
      };
    },
    observeSink: createLlmObservabilitySink({
      resolveCost: resolveObservedGenerationCost,
    }),
  };
}

export function getOrCreateRoutedGatewayClient(configInput: RoutedGatewayConfig) {
  const signature = getRoutedGatewayCacheSignature(configInput);
  const cacheKey = `routed:${configInput.versionId}`;
  const cached = gatewayClientCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.client;
  }

  const client = createModelGateway(buildRoutedModelGatewayConfig(configInput));

  // Only one config version is active at a time, so entries keyed by any other
  // versionId can never be hit again. Without this, every config sync (catalog
  // discovery, pricing refresh) leaks a client holding provider config and
  // model-factory references for the lifetime of the process.
  for (const staleKey of gatewayClientCache.keys()) {
    if (staleKey !== cacheKey) {
      gatewayClientCache.delete(staleKey);
    }
  }

  gatewayClientCache.set(cacheKey, {
    signature,
    client,
  });

  return client;
}

export function resolveModelGatewayTimeoutMs(value?: number | null) {
  return value ?? DEFAULT_TIMEOUT_MS;
}

export function resolveModelGatewayMaxRetries(value?: number | null) {
  return value ?? DEFAULT_MAX_RETRIES;
}
