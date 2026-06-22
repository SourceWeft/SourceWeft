import { ModelGatewayError } from "./errors";
import { buildProviderAuthHeaders } from "./auth-headers";
import type {
  CustomByokProviderConfig,
  GatewayExecutionInput,
  ModelGatewayConfig,
  RequestOptions,
  ResolvedGatewayProviderConfig,
  ResolvedModelGatewayConfig,
  ResolvedModelRouteConfig,
  ResolvedRequestConfig,
  ResolvedRequestTarget,
  RoutingStrategy,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_PROVIDER_NAME = "default";

export const DEFAULT_ALLOWED_MODEL_ALIASES: readonly string[] = [
  "chat-default",
  "embed-default",
  "rerank-default",
  "asr-default",
  "tts-default",
  "image-default",
];

function normalizeBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Invalid model gateway baseUrl: ${baseUrl}`,
      retryable: false,
    });
  }
}

function ensureBaseUrlAllowed(baseUrl: string, allowed: readonly string[]) {
  if (allowed.length === 0) {
    return;
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedAllowed = allowed.map((item) => normalizeBaseUrl(item));

  if (!normalizedAllowed.includes(normalizedBase)) {
    throw new ModelGatewayError({
      code: "AUTH",
      message: `Model gateway baseUrl is not in allow list: ${normalizedBase}`,
      retryable: false,
    });
  }
}

function normalizeProviderConfigs(
  config: ModelGatewayConfig,
): Record<string, ResolvedGatewayProviderConfig> {
  const allowedBaseUrls = config.allowedBaseUrls ?? [];
  const providers = config.providers ?? {
    [DEFAULT_PROVIDER_NAME]: {
      kind: "openai-compatible",
      baseUrl: config.baseUrl ?? "",
      apiKey: config.apiKey,
      apiKeyHeaderName: config.apiKeyHeaderName,
      apiKeyHeaderPrefix: config.apiKeyHeaderPrefix,
      defaultHeaders: config.defaultHeaders,
      enabled: true,
    },
  };

  const normalizedEntries = Object.entries(providers).map(([name, provider]) => {
    if (!provider?.baseUrl) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: `Provider '${name}' is missing baseUrl`,
        retryable: false,
      });
    }

    const baseUrl = normalizeBaseUrl(provider.baseUrl);
    ensureBaseUrlAllowed(baseUrl, allowedBaseUrls);

    return [
      name,
      {
        name,
        kind: provider.kind,
        baseUrl,
        apiKey: provider.apiKey,
        apiKeyHeaderName: provider.apiKeyHeaderName,
        apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
        defaultHeaders: provider.defaultHeaders ?? {},
        supports: provider.supports ?? [],
        enabled: provider.enabled ?? true,
      },
    ] as const;
  });

  return Object.fromEntries(normalizedEntries);
}

function buildImplicitRoutes(
  config: ModelGatewayConfig,
): Record<string, ResolvedModelRouteConfig> {
  const aliases =
    config.allowedModelAliases && config.allowedModelAliases.length > 0
      ? config.allowedModelAliases
      : DEFAULT_ALLOWED_MODEL_ALIASES;

  return Object.fromEntries(
    aliases.map((alias) => [
      alias,
      {
        alias,
        strategy: config.routingStrategyDefault ?? "priority",
        targets: [
          {
            provider: DEFAULT_PROVIDER_NAME,
            model: alias,
            weight: 100,
            priority: 1,
            enabled: true,
          },
        ],
      },
    ]),
  );
}

function normalizeRoutes(
  config: ModelGatewayConfig,
): Record<string, ResolvedModelRouteConfig> {
  const routes = config.modelRoutes;
  if (!routes || Object.keys(routes).length === 0) {
    return buildImplicitRoutes(config);
  }

  return Object.fromEntries(
    Object.entries(routes).map(([alias, route]) => {
      if (!route.targets || route.targets.length === 0) {
        throw new ModelGatewayError({
          code: "BAD_REQUEST",
          message: `Model route '${alias}' must declare at least one target`,
          retryable: false,
        });
      }

      return [
        alias,
        {
          alias,
          strategy: route.strategy ?? config.routingStrategyDefault ?? "priority",
          targets: route.targets.map((target, index) => ({
            provider: target.provider,
            model: target.model,
            weight: target.weight ?? 0,
            priority: target.priority ?? index + 1,
            enabled: target.enabled ?? true,
            ...(target.providerRouting
              ? { providerRouting: target.providerRouting }
              : {}),
          })),
        },
      ] as const;
    }),
  );
}

export function resolveModelGatewayConfig(
  config: ModelGatewayConfig,
): ResolvedModelGatewayConfig {
  const fetchFn = config.fetch ?? globalThis.fetch;

  if (typeof fetchFn !== "function") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "A fetch implementation is required for model gateway client",
      retryable: false,
    });
  }

  const providers = normalizeProviderConfigs(config);
  const routes = normalizeRoutes(config);
  const defaultProvider = providers[DEFAULT_PROVIDER_NAME] ?? Object.values(providers)[0];

  for (const route of Object.values(routes)) {
    for (const target of route.targets) {
      if (!providers[target.provider]) {
        throw new ModelGatewayError({
          code: "BAD_REQUEST",
          message: `Model route '${route.alias}' references unknown provider '${target.provider}'`,
          retryable: false,
        });
      }
    }
  }

  return {
    baseUrl: defaultProvider?.baseUrl ?? "",
    apiKey: defaultProvider?.apiKey,
    apiKeyHeaderName: defaultProvider?.apiKeyHeaderName,
    apiKeyHeaderPrefix: defaultProvider?.apiKeyHeaderPrefix,
    providers,
    routes,
    fetch: fetchFn,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    defaultHeaders: {
      "Content-Type": "application/json",
      ...(config.defaultHeaders ?? {}),
    },
    allowNonDefaultAliases: config.allowNonDefaultAliases ?? false,
    allowedModelAliases: Object.keys(routes),
    allowedBaseUrls: config.allowedBaseUrls ?? [],
    modeDefault: config.modeDefault ?? "GLOBAL",
    routingStrategyDefault: config.routingStrategyDefault ?? "priority",
    byokProviderAllowList: config.byokProviderAllowList ?? [],
    resolveApiKeyRef: config.resolveApiKeyRef,
    resolveCustomByokProvider: config.resolveCustomByokProvider,
    logger: config.logger ?? {},
    requestMetadata: config.requestMetadata ?? {},
    observeSink: config.observeSink,
    langchainFactories: config.langchainFactories,
  };
}

export function assertModelAliasAllowed(
  model: string,
  config: ResolvedModelGatewayConfig,
) {
  if (config.allowNonDefaultAliases) {
    return;
  }

  if (!config.allowedModelAliases.includes(model)) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message:
        `Model alias '${model}' is not allowed. ` +
        `Allowed aliases: ${config.allowedModelAliases.join(", ")}`,
      retryable: false,
    });
  }
}

async function maybeResolveByokApiKey(
  config: ResolvedModelGatewayConfig,
  execution: GatewayExecutionInput,
): Promise<string | undefined> {
  if (!execution.byok) {
    return undefined;
  }

  if (execution.byok.apiKey) {
    return execution.byok.apiKey;
  }

  if (execution.byok.apiKeyRef && config.resolveApiKeyRef) {
    const resolved = await config.resolveApiKeyRef({
      provider: execution.byok.provider,
      apiKeyRef: execution.byok.apiKeyRef,
      metadata: "metadata" in execution && execution.metadata && typeof execution.metadata === "object"
        ? (execution.metadata as Record<string, unknown>)
        : undefined,
    });
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

async function resolveByokApiKey(
  config: ResolvedModelGatewayConfig,
  execution: GatewayExecutionInput,
): Promise<string> {
  const apiKey = await maybeResolveByokApiKey(config, execution);
  if (apiKey) {
    return apiKey;
  }

  throw new ModelGatewayError({
    code: "AUTH",
    message: `No API key resolved for BYOK provider '${execution.byok?.provider}'`,
    retryable: false,
  });
}

function resolveExecutionMetadata(
  execution: GatewayExecutionInput,
): Record<string, unknown> | undefined {
  if (!("metadata" in execution)) {
    return undefined;
  }

  const { metadata } = execution as { metadata?: unknown };
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

async function resolveCustomByokProvider(
  config: ResolvedModelGatewayConfig,
  execution: GatewayExecutionInput & { model: string },
  providerName: string,
  apiKey?: string,
): Promise<ResolvedGatewayProviderConfig | null> {
  const customProvider = await config.resolveCustomByokProvider?.({
    provider: providerName,
    model: execution.model,
    profileAlias: execution.profileAlias,
    apiKey,
    apiKeyRef: execution.byok?.apiKeyRef,
    metadata: resolveExecutionMetadata(execution),
  });

  if (!customProvider?.baseUrl) {
    return null;
  }

  return normalizeCustomByokProvider(providerName, customProvider, config.allowedBaseUrls);
}

function resolveInlineByokProvider(input: {
  config: ResolvedModelGatewayConfig;
  execution: GatewayExecutionInput;
  providerName: string;
  configuredProvider?: ResolvedGatewayProviderConfig;
  apiKey?: string;
}): ResolvedGatewayProviderConfig | null {
  const baseUrl = input.execution.byok?.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }

  return normalizeCustomByokProvider(
    input.providerName,
    {
      kind:
        input.execution.byok?.providerKind ??
        input.configuredProvider?.kind ??
        "openai-compatible",
      baseUrl,
      apiKey: input.apiKey,
      apiKeyHeaderName: input.execution.byok?.apiKeyHeaderName,
      apiKeyHeaderPrefix: input.execution.byok?.apiKeyHeaderPrefix,
      defaultHeaders: input.execution.byok?.defaultHeaders,
      supports: input.configuredProvider?.supports,
      enabled: input.configuredProvider?.enabled ?? true,
    },
    input.config.allowedBaseUrls,
  );
}

function normalizeCustomByokProvider(
  name: string,
  provider: CustomByokProviderConfig,
  allowedBaseUrls: readonly string[],
): ResolvedGatewayProviderConfig {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  ensureBaseUrlAllowed(baseUrl, allowedBaseUrls);

  return {
    name,
    kind: provider.kind,
    baseUrl,
    apiKey: provider.apiKey,
    apiKeyHeaderName: provider.apiKeyHeaderName,
    apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
    defaultHeaders: provider.defaultHeaders ?? {},
    supports: provider.supports ?? [],
    enabled: provider.enabled ?? true,
  };
}

function selectTargetByStrategy(
  strategy: RoutingStrategy,
  candidates: ResolvedModelRouteConfig["targets"],
) {
  if (strategy === "weighted-random") {
    const weighted = candidates.filter((item) => item.weight > 0);
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (total > 0) {
      let cursor = Math.random() * total;
      for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) {
          return item;
        }
      }
    }

    return [...candidates].sort((a, b) => a.priority - b.priority)[0];
  }

  if (strategy === "priority") {
    return [...candidates].sort((a, b) => a.priority - b.priority)[0];
  }

  throw new ModelGatewayError({
    code: "BAD_REQUEST",
    message:
      `Routing strategy '${strategy}' is not implemented in this gateway. ` +
      "Use 'priority' or 'weighted-random'.",
    retryable: false,
  });
}

export async function resolveRequestTarget(
  config: ResolvedModelGatewayConfig,
  execution: GatewayExecutionInput & {
    model: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ResolvedRequestTarget> {
  const mode = execution.executionMode ?? config.modeDefault;

  if (mode === "BYOK") {
    const providerName = execution.byok?.provider ?? execution.providerHint;
    if (!providerName) {
      throw new ModelGatewayError({
        code: "POLICY",
        message: "BYOK mode requires a provider selection",
        retryable: false,
      });
    }

    if (
      config.byokProviderAllowList.length > 0 &&
      !config.byokProviderAllowList.includes(providerName)
    ) {
      throw new ModelGatewayError({
        code: "POLICY",
        message: `BYOK provider '${providerName}' is not allowed`,
        retryable: false,
      });
    }

    const resolvedApiKey = await maybeResolveByokApiKey(config, execution);
    const configuredProvider = config.providers[providerName];
    const inlineProvider = resolveInlineByokProvider({
      config,
      execution,
      providerName,
      configuredProvider,
      apiKey: resolvedApiKey,
    });
    const customProvider = configuredProvider || inlineProvider
      ? null
      : await resolveCustomByokProvider(
        config,
        execution,
        providerName,
        resolvedApiKey,
      );
    const provider = inlineProvider ?? configuredProvider ?? customProvider;

    if (!provider || !provider.enabled) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: `Unknown or disabled provider '${providerName}'`,
        retryable: false,
      });
    }

    const apiKey = inlineProvider?.apiKey ?? customProvider?.apiKey ?? resolvedApiKey;
    if (!apiKey) {
      throw new ModelGatewayError({
        code: "AUTH",
        message: `No API key resolved for BYOK provider '${providerName}'`,
        retryable: false,
      });
    }

    return {
      provider: provider.name,
      providerKind: provider.kind,
      providerModel: execution.model,
      baseUrl: provider.baseUrl,
      apiKey,
      apiKeyHeaderName: provider.apiKeyHeaderName,
      apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
      defaultHeaders: provider.defaultHeaders,
      routeDecision: {
        alias: `${provider.name}:${execution.model}`,
        mode,
        strategy: "priority",
        provider: provider.name,
        providerKind: provider.kind,
      },
      requestMetadata: config.requestMetadata,
    };
  }

  const routeKey = execution.profileAlias ?? execution.model;
  const route = config.routes[routeKey];
  if (!route) {
    assertModelAliasAllowed(routeKey, config);
    const provider = config.providers[DEFAULT_PROVIDER_NAME];
    if (!provider) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: `No route configured for alias '${routeKey}'`,
        retryable: false,
      });
    }
    return {
      provider: provider.name,
      providerKind: provider.kind,
      providerModel: execution.model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiKeyHeaderName: provider.apiKeyHeaderName,
      apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
      defaultHeaders: provider.defaultHeaders,
      routeDecision: {
        alias: routeKey,
        mode,
        strategy: "priority",
        provider: provider.name,
        providerKind: provider.kind,
      },
      requestMetadata: config.requestMetadata,
    };
  }

  const candidates = route.targets.filter((target) => {
    if (!target.enabled) {
      return false;
    }
    const provider = config.providers[target.provider];
    if (!provider?.enabled) {
      return false;
    }
    if (execution.providerHint && target.provider !== execution.providerHint) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    throw new ModelGatewayError({
      code: "UPSTREAM",
      message: `No active route target available for alias '${routeKey}'`,
      retryable: true,
    });
  }

  const selected = selectTargetByStrategy(route.strategy, candidates);
  if (!selected) {
    throw new ModelGatewayError({
      code: "UPSTREAM",
      message: `Failed to select route target for alias '${routeKey}'`,
      retryable: true,
    });
  }

  const provider = config.providers[selected.provider]!;
  return {
    provider: provider.name,
    providerKind: provider.kind,
    providerModel: selected.model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyHeaderName: provider.apiKeyHeaderName,
    apiKeyHeaderPrefix: provider.apiKeyHeaderPrefix,
    defaultHeaders: provider.defaultHeaders,
    ...(selected.providerRouting
      ? { providerRouting: selected.providerRouting }
      : {}),
    routeDecision: {
      alias: routeKey,
      mode,
      strategy: route.strategy,
      provider: provider.name,
      providerKind: provider.kind,
      ...(selected.providerRouting
        ? { providerRouting: selected.providerRouting }
        : {}),
    },
    requestMetadata: config.requestMetadata,
  };
}

export function createRequestConfig(
  config: ResolvedModelGatewayConfig,
  target: ResolvedRequestTarget,
): ResolvedRequestConfig {
  return {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    apiKeyHeaderName: target.apiKeyHeaderName,
    apiKeyHeaderPrefix: target.apiKeyHeaderPrefix,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    defaultHeaders: {
      ...config.defaultHeaders,
      ...target.defaultHeaders,
    },
    logger: config.logger,
    requestMetadata: config.requestMetadata,
    observeSink: config.observeSink,
  };
}

export function buildRequestHeaders(
  config: Pick<
    ResolvedRequestConfig,
    "defaultHeaders" | "apiKey" | "apiKeyHeaderName" | "apiKeyHeaderPrefix"
  >,
  options?: RequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...config.defaultHeaders,
  };

  Object.assign(headers, buildProviderAuthHeaders(config));

  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  return headers;
}
