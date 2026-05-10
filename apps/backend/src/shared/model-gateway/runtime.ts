import {
  createModelGateway,
  type ModelGateway,
  type ModelGatewayConfig,
} from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../database";
import {
  modelGatewayByokKeyRefs,
  modelGatewayConfigVersions,
  modelGatewayConfigs,
  modelGatewayProviderConfigs,
  modelGatewayRoutes,
} from "../db/schema";
import { createLlmObservabilitySink } from "./llm-observability-sink";
import { decryptSecret } from "../secrets";
import type { RoutedGatewayConfig } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const OPENROUTER_APP_TITLE = "SourceWeft";
const OPENROUTER_APP_REFERER = "https://sourceweft.com";

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
  providerKind:
    | "openai-compatible"
    | "openrouter"
    | "deepinfra"
    | "siliconflow-cn"
    | "openai"
    | "anthropic"
    | "gemini"
    | "azure-openai";
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
    "X-Title": OPENROUTER_APP_TITLE,
    "HTTP-Referer": OPENROUTER_APP_REFERER,
  };
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
    .from(modelGatewayByokKeyRefs)
    .where(
      and(
        eq(modelGatewayByokKeyRefs.workspaceId, workspaceId),
        eq(modelGatewayByokKeyRefs.teamId, teamId),
        eq(modelGatewayByokKeyRefs.providerName, input.provider),
        eq(modelGatewayByokKeyRefs.keyRef, input.apiKeyRef),
        eq(modelGatewayByokKeyRefs.isActive, true),
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
      defaultHeaders: withOpenRouterAttributionHeaders({
        providerKind: row.providerKind,
        defaultHeaders: normalizeDefaultHeaders(
          row.configJson && typeof row.configJson === "object"
            ? (row.configJson as Record<string, unknown>).defaultHeaders
            : undefined,
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
    existing.targets.push({
      provider: row.targetProviderName,
      model: row.targetModel,
      priority: row.priority,
      weight: row.weight,
    });
    modelRoutes[row.alias] = existing;
  }

  return {
    versionId: activeVersion.id,
    providers,
    modelRoutes,
  };
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
  const providerSettings = Object.values(configInput.providers);
  const timeoutMs =
    providerSettings.length > 0
      ? Math.max(...providerSettings.map((provider) => provider.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
  const maxRetries =
    providerSettings.length > 0
      ? Math.max(...providerSettings.map((provider) => provider.maxRetries))
      : DEFAULT_MAX_RETRIES;

  return {
    providers: Object.fromEntries(
      Object.entries(configInput.providers).map(([name, provider]) => [
        name,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          defaultHeaders: provider.defaultHeaders,
          supports: provider.supports,
        },
      ]),
    ),
    modelRoutes: configInput.modelRoutes,
    timeoutMs,
    maxRetries,
    allowNonDefaultAliases: false,
    resolveApiKeyRef: resolveByokApiKeyRef,
    observeSink: createLlmObservabilitySink(),
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
