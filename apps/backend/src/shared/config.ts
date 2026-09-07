import "dotenv/config";

import { parseBooleanEnv as parseBoolean } from "./env";
import { parseAllowedInternalOrigins } from "./security/endpoint-policy";

import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";

type AlertLevel = "warn" | "error" | "critical";

function parseStrictBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be one of: true, false, 1, 0.`);
}

function parseBoundedIntegerEnv(input: {
  name: string;
  fallback: number;
  min: number;
  max: number;
}) {
  const value = process.env[input.name];
  if (value === undefined) return input.fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(
      `${input.name} must be an integer between ${input.min} and ${input.max}.`,
    );
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = parseNonNegativeNumber(value, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

const billingModes: ReadonlySet<BillingMode> = new Set([
  "disabled",
  "shadow",
  "enforced",
]);

const billingScopes: ReadonlySet<BillingScope> = new Set([
  "individual_only",
  "team_enabled",
]);

const billingProviders: ReadonlySet<BillingProvider> = new Set([
  "none",
  "creem",
  "stripe",
  "manual",
]);

const documentParseProviders = new Set([
  "langchain",
  "pdf2markdown",
  "docling",
  "llamaparse",
  "unstructured",
]);

const documentParseStrategies = new Set([
  "explicit",
  "balanced",
  "cost",
  "quality",
]);

const pdf2MarkdownOutputs = new Set(["markdown", "json", "all"]);

const planFamilies: ReadonlySet<PlanFamily> = new Set([
  "individual_free",
  "individual_pro",
  "team_standard",
  "team_premium",
  "enterprise_usage",
]);

function parseBillingMode(value: string | undefined, fallback: BillingMode) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingMode;
  return billingModes.has(normalized) ? normalized : fallback;
}

function parseBillingScope(value: string | undefined, fallback: BillingScope) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingScope;
  return billingScopes.has(normalized) ? normalized : fallback;
}

function parseBillingProvider(
  value: string | undefined,
  fallback: BillingProvider,
) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingProvider;
  return billingProviders.has(normalized) ? normalized : fallback;
}

function parsePlanFamily(value: string | undefined, fallback: PlanFamily) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as PlanFamily;
  return planFamilies.has(normalized) ? normalized : fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Confidential OAuth clients for MCP providers that don't support Dynamic Client
 * Registration (e.g. Stripe, GitHub). Parsed from a JSON array of
 * { issuer, clientId, clientSecret } and keyed by the issuer's origin, so a
 * configured client is only ever matched to — and sent to — its own
 * authorization server. Malformed entries are skipped.
 */
function parseOAuthClients(
  value: string | undefined,
): Record<string, { clientId: string; clientSecret?: string }> {
  if (!value?.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, { clientId: string; clientSecret?: string }> = {};
  for (const entry of parsed) {
    const issuer = typeof entry?.issuer === "string" ? entry.issuer : null;
    const clientId =
      typeof entry?.clientId === "string" ? entry.clientId : null;
    if (!issuer || !clientId) {
      continue;
    }
    try {
      const origin = new URL(issuer).origin;
      out[origin] = {
        clientId,
        clientSecret:
          typeof entry?.clientSecret === "string"
            ? entry.clientSecret
            : undefined,
      };
    } catch {
      // Skip an entry whose issuer is not a valid URL.
    }
  }
  return out;
}

function parseAlertLevel(value: string | undefined, fallback: AlertLevel) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "critical"
  ) {
    return normalized;
  }

  return fallback;
}

function parseDocumentParseProvider(
  value: string | undefined,
  fallback: string,
) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (documentParseProviders.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `DOCUMENT_PARSE_PROVIDER must be one of: ${[...documentParseProviders].join(", ")}.`,
  );
}

function parseDocumentParseStrategy(
  value: string | undefined,
  fallback: string,
) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return documentParseStrategies.has(normalized) ? normalized : fallback;
}

/**
 * Which upload path the API offers clients.
 *
 * `proxy` is the default because it is the one that works against any
 * S3-compatible store with no store-side setup at all. `direct` hands the
 * browser a presigned PUT, which is faster and keeps the file out of the API
 * process, but a browser cannot use it unless the bucket carries a CORS policy
 * — a step a self-hosted or single-user deployment should never be forced into.
 */
const sourceUploadModes = new Set(["proxy", "direct"]);

function parseSourceUploadMode(value: string | undefined): "proxy" | "direct" {
  const normalized = value?.trim().toLowerCase();
  return normalized && sourceUploadModes.has(normalized)
    ? (normalized as "proxy" | "direct")
    : "proxy";
}

function parsePdf2MarkdownOutput(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return pdf2MarkdownOutputs.has(normalized) ? normalized : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireEnvInProduction(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `Missing required environment variable in production: ${name}`,
    );
  }

  return fallback;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = parsePositiveNumber(value, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function isValidExtensionId(value: string) {
  return /^[a-z]{32}$/.test(value);
}

function resolveExtensionId() {
  const explicitId = process.env.AUTH_EXTENSION_ID?.trim().toLowerCase();
  if (explicitId && isValidExtensionId(explicitId)) {
    return explicitId;
  }

  const redirectUri = process.env.AUTH_EXTENSION_REDIRECT_URI?.trim();
  if (!redirectUri) {
    return null;
  }

  try {
    const url = new URL(redirectUri);
    const match = url.hostname.match(/^([a-z]{32})\.chromiumapp\.org$/);
    if (match?.[1] && isValidExtensionId(match[1])) {
      return match[1];
    }
  } catch {
    return null;
  }

  return null;
}

function resolveExtensionOrigins() {
  const extensionId = resolveExtensionId();
  if (!extensionId) {
    return [];
  }

  return [
    `chrome-extension://${extensionId}`,
    `https://${extensionId}.chromiumapp.org`,
  ];
}

function resolveExtensionRedirectUri() {
  const configured = process.env.AUTH_EXTENSION_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }

  const extensionId = resolveExtensionId();
  if (extensionId) {
    return `https://${extensionId}.chromiumapp.org/provider_cb`;
  }

  return "https://<extension-id>.chromiumapp.org/provider_cb";
}

function resolveApiBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) {
    return stripTrailingSlash(configured);
  }

  return "http://localhost:3001";
}

function resolveWebBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim();
  if (configured) {
    return stripTrailingSlash(configured);
  }

  return "http://localhost:3000";
}

function resolveTrustedOrigins() {
  const configured = parseCsv(process.env.BETTER_AUTH_TRUSTED_ORIGINS);
  const defaults = [
    resolveApiBaseUrl(),
    resolveWebBaseUrl(),
    ...resolveExtensionOrigins(),
  ];

  return Array.from(new Set([...defaults, ...configured]));
}

function resolveAuthErrorUrl() {
  const configured = process.env.BETTER_AUTH_ERROR_URL?.trim();
  if (configured) {
    return configured;
  }

  return `${resolveWebBaseUrl()}/auth/error`;
}

function resolvePasskeyOrigin() {
  const configured = process.env.AUTH_PASSKEY_ORIGIN?.trim();
  if (configured) {
    return configured;
  }

  return resolveWebBaseUrl();
}

const saasEnabled = parseBoolean(process.env.SOURCEWEFT_SAAS_ENABLED, false);
const requestedBillingProvider = parseBillingProvider(
  process.env.BACKEND_BILLING_PROVIDER,
  "none",
);
// SOURCEWEFT_SAAS_ENABLED is the payment/subscription gate for OSS deploys:
// provider credentials alone must not turn checkout on, and only Creem is a
// provider-backed checkout path in this release.
const effectiveBillingProvider: BillingProvider =
  saasEnabled && requestedBillingProvider === "creem" ? "creem" : "none";
const queueName = process.env.JOB_QUEUE_NAME || "sourceweft-jobs";
const agentInterpreterLimits = {
  executionTimeoutMs: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_EXECUTION_TIMEOUT_MS",
    fallback: 3_000,
    min: 100,
    max: 5_000,
  }),
  memoryLimitBytes: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MEMORY_LIMIT_BYTES",
    fallback: 32 * 1024 * 1024,
    min: 8 * 1024 * 1024,
    max: 64 * 1024 * 1024,
  }),
  maxStackSizeBytes: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_STACK_SIZE_BYTES",
    fallback: 320 * 1024,
    min: 64 * 1024,
    max: 512 * 1024,
  }),
  maxResultChars: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_RESULT_CHARS",
    fallback: 2_000,
    min: 256,
    max: 8_000,
  }),
  maxPtcCallsPerEval: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_EVAL",
    fallback: 8,
    min: 1,
    max: 16,
  }),
  maxPtcCallsPerTurn: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_TURN",
    fallback: 24,
    min: 1,
    max: 64,
  }),
  maxEvalsPerTurn: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_EVALS_PER_TURN",
    fallback: 6,
    min: 1,
    max: 12,
  }),
  maxConcurrentEvals: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_CONCURRENT_EVALS",
    fallback: 4,
    min: 1,
    max: 8,
  }),
  maxConcurrentPtcPerTurn: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_CONCURRENT_PTC_PER_TURN",
    fallback: 4,
    min: 1,
    max: 8,
  }),
  evalQueueTimeoutMs: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_EVAL_QUEUE_TIMEOUT_MS",
    fallback: 1_000,
    min: 100,
    max: 5_000,
  }),
  ptcCallTimeoutMs: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_PTC_CALL_TIMEOUT_MS",
    fallback: 5_000,
    min: 100,
    max: 10_000,
  }),
  maxCodeChars: parseBoundedIntegerEnv({
    name: "SOURCEWEFT_AGENT_INTERPRETER_MAX_CODE_CHARS",
    fallback: 20_000,
    min: 1_000,
    max: 50_000,
  }),
};

if (
  agentInterpreterLimits.maxPtcCallsPerTurn <
  agentInterpreterLimits.maxPtcCallsPerEval
) {
  throw new Error(
    "SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_TURN must be greater than or equal to SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_EVAL.",
  );
}

export const config = {
  apiHost: process.env.BACKEND_API_HOST || "0.0.0.0",
  apiPort: Number(process.env.PORT || process.env.BACKEND_API_PORT || 3001),
  apiPerformance: {
    largeResponseThresholdBytes: parsePositiveNumber(
      process.env.BACKEND_API_LARGE_RESPONSE_THRESHOLD_BYTES,
      512 * 1024,
    ),
    slowRequestThresholdMs: parsePositiveNumber(
      process.env.BACKEND_API_SLOW_REQUEST_THRESHOLD_MS,
      1000,
    ),
  },
  databaseUrl: requireEnvInProduction(
    "DATABASE_URL",
    "postgres://postgres:postgres@127.0.0.1:5432/sourceweft",
  ),
  redisUrl: requireEnvInProduction("REDIS_URL", "redis://127.0.0.1:6379"),
  queueName,
  deliverablesQueueName: `${queueName}-deliverables`,
  deliverablesWorkerConcurrency: parsePositiveInteger(
    process.env.DELIVERABLE_WORKER_CONCURRENCY,
    1,
  ),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60000),
  chat: {
    defaultModelAlias:
      process.env.CHAT_DEFAULT_MODEL_ALIAS?.trim() || "chat-default",
    toolApprovalTtlMs: parsePositiveNumber(
      process.env.CHAT_TOOL_APPROVAL_TTL_MS,
      30 * 60 * 1000,
    ),
    agent: {
      defaultContextLength: 32_768,
      maxReservedOutputTokens: 8_192,
      maxGrepRecallTopK: 300,
      maxReadOutputChars: 80_000,
      toolCallRunLimit: parsePositiveInteger(
        process.env.SOURCEWEFT_AGENT_TOOL_CALL_RUN_LIMIT,
        48,
      ),
      toolCallThreadLimit: parsePositiveInteger(
        process.env.SOURCEWEFT_AGENT_TOOL_CALL_THREAD_LIMIT,
        300,
      ),
      interpreter: {
        enabled: parseStrictBooleanEnv(
          "SOURCEWEFT_AGENT_INTERPRETER_ENABLED",
          false,
        ),
        limits: agentInterpreterLimits,
      },
      // Proactive clarifying questions (Claude-Code-style `askUser`). On by
      // default; the askUser middleware is added to the root and sub-agent
      // graphs. Set SOURCEWEFT_AGENT_ASK_USER_ENABLED=false (or 0) to disable.
      // See docs/architecture/proactive-ask-user.md.
      askUserEnabled: parseBoolean(
        process.env.SOURCEWEFT_AGENT_ASK_USER_ENABLED,
        true,
      ),
    },
  },
  sandbox: {
    enabled: parseBoolean(process.env.SOURCEWEFT_SANDBOX_ENABLED, false),
    toolApprovalEnabled: parseBoolean(
      process.env.SOURCEWEFT_SANDBOX_TOOL_APPROVAL_ENABLED,
      false,
    ),
    provider: process.env.SOURCEWEFT_SANDBOX_PROVIDER || "daytona",
    ttlSeconds: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_TTL_SECONDS,
      3600,
    ),
    // Timeout for commands issued inside a conversational turn. The command
    // text there comes from the model, so this is the limit that stops one
    // runaway command from holding a sandbox; raise it and every model-issued
    // command gets the longer hold.
    commandTimeoutMs: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_COMMAND_TIMEOUT_MS,
      120000,
    ),
    // Timeout for deterministic host-issued batch work (installs, type checks,
    // renders). 8 minutes because that is the longest per-stage budget any
    // deliverable pipeline declares today: a command allowed to outrun the
    // stage containing it can only wedge that stage.
    batchCommandTimeoutMs: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_BATCH_COMMAND_TIMEOUT_MS,
      480000,
    ),
    // Absolute cap every command budget is clamped to. 10 minutes: comfortably
    // above the longest host stage above, and far below the sandbox TTL
    // (`ttlSeconds`, 1h) so no command can outlive the sandbox it runs in. This
    // exists so a mis-set budget env var cannot pin a sandbox indefinitely.
    maxCommandTimeoutMs: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_COMMAND_TIMEOUT_MS,
      600000,
    ),
    maxOutputChars: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_OUTPUT_CHARS,
      80000,
    ),
    maxPrepareFileBytes: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_PREPARE_FILE_BYTES,
      10 * 1024 * 1024,
    ),
    maxPrepareTotalBytes: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_PREPARE_TOTAL_BYTES,
      25 * 1024 * 1024,
    ),
    maxCollectFileBytes: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_COLLECT_FILE_BYTES,
      25 * 1024 * 1024,
    ),
    maxCollectTotalBytes: parsePositiveInteger(
      process.env.SOURCEWEFT_SANDBOX_MAX_COLLECT_TOTAL_BYTES,
      50 * 1024 * 1024,
    ),
    // No per-provider block lives here. Which provider a deployment runs on is
    // `provider` above — an opaque id the host matches against whatever
    // capabilities declare `sandbox_provider` — and every setting a particular
    // provider needs is read by that provider's own capability package. A
    // `daytona: { apiUrl, apiKey, … }` block here made the generic host carry
    // one vendor's identity, and would have grown a sibling per provider.
  },
  s3: {
    region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET || "",
    endpoint: process.env.S3_ENDPOINT || "",
    accessKeyId:
      process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.S3_SECRET_ACCESS_KEY ||
      "",
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, false),
  },
  publicS3: {
    region: process.env.PUBLIC_S3_REGION || "auto",
    bucket: process.env.PUBLIC_S3_BUCKET || "",
    endpoint: process.env.PUBLIC_S3_ENDPOINT || "",
    accessKeyId: process.env.PUBLIC_S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.PUBLIC_S3_SECRET_ACCESS_KEY || "",
    forcePathStyle: parseBoolean(process.env.PUBLIC_S3_FORCE_PATH_STYLE, true),
    baseUrl: stripTrailingSlash(process.env.PUBLIC_S3_BASE_URL || ""),
  },
  blog: {
    notionApiKey: process.env.NOTION_BLOG_API_KEY || "",
    notionApiBaseUrl: stripTrailingSlash(
      process.env.NOTION_API_BASE_URL || "https://api.notion.com",
    ),
    notionDatabaseId: process.env.NOTION_BLOG_DATABASE_ID || "",
    notionDataSourceId: process.env.NOTION_BLOG_DATA_SOURCE_ID || "",
    notionVersion: process.env.NOTION_BLOG_VERSION || "2026-03-11",
    assetMaxBytes: parsePositiveInteger(
      process.env.BLOG_ASSET_MAX_BYTES,
      15 * 1024 * 1024,
    ),
  },
  sourceUpload: {
    mode: parseSourceUploadMode(process.env.SOURCE_UPLOAD_MODE),
  },
  documentParsing: {
    strategy: parseDocumentParseStrategy(
      process.env.DOCUMENT_PARSE_STRATEGY,
      "explicit",
    ),
    provider: parseDocumentParseProvider(
      process.env.DOCUMENT_PARSE_PROVIDER,
      "pdf2markdown",
    ),
    pureTextBitmapThreshold: 0.05,
    pureTextMinCharsPerPage: 80,
    // Configurable so shipping a new parser version does not require a code
    // change to become the default for newly ingested sources.
    defaultParserVersion:
      process.env.DOCUMENT_PARSE_DEFAULT_PARSER_VERSION?.trim() ||
      "v2-document-provider",
    defaultChunkSize: parsePositiveInteger(
      process.env.DOCUMENT_PARSE_DEFAULT_CHUNK_SIZE,
      1000,
    ),
  },
  vectorSearch: {
    /**
     * Ceiling enforced by PgVectorProvider. Tied to the pgvector column/index
     * configuration in use, not an inherent limit — raising it requires
     * confirming the HNSW indexes can support the wider vectors.
     */
    maxDimensions: parsePositiveInteger(
      process.env.VECTOR_SEARCH_MAX_DIMENSIONS,
      2000,
    ),
  },
  pdf2markdown: {
    apiKey: process.env.PDF2MARKDOWN_API_KEY || "",
    baseUrl: stripTrailingSlash(
      process.env.PDF2MARKDOWN_BASE_URL || "https://pdf2markdown.io/api",
    ),
    output: parsePdf2MarkdownOutput(process.env.PDF2MARKDOWN_OUTPUT, "all"),
    pollInitialDelayMs: parsePositiveNumber(
      process.env.PDF2MARKDOWN_POLL_INITIAL_DELAY_MS,
      2000,
    ),
    pollMaxDelayMs: parsePositiveNumber(
      process.env.PDF2MARKDOWN_POLL_MAX_DELAY_MS,
      15000,
    ),
    pollMaxAttempts: parsePositiveNumber(
      process.env.PDF2MARKDOWN_POLL_MAX_ATTEMPTS,
      40,
    ),
    requestTimeoutMs: parsePositiveNumber(
      process.env.PDF2MARKDOWN_REQUEST_TIMEOUT_MS,
      30000,
    ),
  },
  market: {
    // The MCP catalog now lives in-process (sourceweft-api retired). This flag
    // just feature-gates the market; there is no external service, signing, or
    // trust-key configuration anymore.
    enabled: parseBoolean(process.env.MARKET_ENABLED, true),
    // How often to federate the catalog from upstream MCP registries.
    federationIntervalMs: parsePositiveNumber(
      process.env.MARKET_FEDERATION_INTERVAL_MS,
      6 * 60 * 60 * 1000,
    ),
    // Users allowed to review/publish/reject submitted MCP servers. A v1
    // allowlist; the gate is abstracted (requireMarketAdmin) so this can later
    // become a DB-backed role without touching the endpoints.
    adminUserIds: parseCsv(process.env.MARKET_ADMIN_USER_IDS),
  },
  // Only the explicit local development mode relaxes endpoint address policy.
  // Test, production and an omitted NODE_ENV retain the same strict checks.
  endpointAddressChecksEnabled: process.env.NODE_ENV !== "development",
  mcpAllowedInternalOrigins: parseAllowedInternalOrigins(
    "MCP_ALLOWED_INTERNAL_ORIGINS",
    process.env.MCP_ALLOWED_INTERNAL_ORIGINS,
  ),
  llmAllowedInternalOrigins: parseAllowedInternalOrigins(
    "LLM_ALLOWED_INTERNAL_ORIGINS",
    process.env.LLM_ALLOWED_INTERNAL_ORIGINS,
  ),
  mcpOAuth: {
    // Callback our backend exposes for the MCP OAuth authorization-code flow. It
    // must be registered with any confidential (non-DCR) provider's OAuth app;
    // DCR/public providers pick it up automatically.
    redirectUrl:
      process.env.MCP_OAUTH_REDIRECT_URL?.trim() ||
      `${resolveApiBaseUrl()}/v1/mcp/oauth/callback`,
    // Client name advertised during (dynamic) registration / authorization.
    clientName: process.env.MCP_OAUTH_CLIENT_NAME?.trim() || "SourceWeft",
    // Confidential clients for providers without DCR, keyed by issuer origin. A
    // client is only ever used for its matching issuer; DCR/public providers
    // need no entry. See parseOAuthClients.
    clients: parseOAuthClients(process.env.MCP_OAUTH_CLIENTS),
  },
  modelPricingSyncIntervalMs: parsePositiveNumber(
    process.env.MODEL_PRICING_SYNC_INTERVAL_MS,
    60 * 60 * 1000,
  ),
  // Periodic in-process refresh of the normalized model catalog (models.dev +
  // LiteLLM + overrides) so long-running servers pick up capability/pricing
  // updates without a restart. 0 disables (rely on startup preheat only).
  modelCatalogRefreshIntervalMs: parsePositiveNumber(
    process.env.MODEL_CATALOG_REFRESH_INTERVAL_MS,
    6 * 60 * 60 * 1000,
  ),
  modelGatewayEncryptionSecret: requireEnv("MODEL_GATEWAY_ENCRYPTION_SECRET"),
  openrouterModelsApiUrl:
    process.env.OPENROUTER_MODELS_API_URL ||
    "https://openrouter.ai/api/v1/models",
  openrouterAppReferer: "https://sourceweft.com",
  litellmPricingUrl:
    process.env.LITELLM_PRICING_URL ||
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  modelsDevApiUrl:
    process.env.MODELS_DEV_API_URL || "https://models.dev/api.json",
  byokDefaultProviderKind:
    process.env.BYOK_DEFAULT_PROVIDER_KIND?.trim() || "openai-compatible",
  auth: {
    secret: requireEnv("BETTER_AUTH_SECRET"),
    baseUrl: resolveApiBaseUrl(),
    webBaseUrl: resolveWebBaseUrl(),
    errorUrl: resolveAuthErrorUrl(),
    trustedOrigins: resolveTrustedOrigins(),
    googleSignInWebClientId:
      process.env.AUTH_GOOGLE_SIGNIN_WEB_CLIENT_ID?.trim() || "",
    googleSignInWebClientSecret:
      process.env.AUTH_GOOGLE_SIGNIN_WEB_CLIENT_SECRET?.trim() || "",
    googleOneTapClientId:
      process.env.AUTH_GOOGLE_ONE_TAP_CLIENT_ID?.trim() || "",
    googleMobileClientId: process.env.AUTH_GOOGLE_MOBILE_CLIENT_ID || "",
    githubClientId: process.env.AUTH_GITHUB_CLIENT_ID || "",
    githubClientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET || "",
    passkey: {
      rpId: process.env.AUTH_PASSKEY_RP_ID || "localhost",
      rpName: process.env.AUTH_PASSKEY_RP_NAME || "SourceWeft",
      origin: resolvePasskeyOrigin(),
    },
    extensionClientId:
      process.env.AUTH_EXTENSION_CLIENT_ID || "sourceweft-extension",
    extensionEnabled: Boolean(resolveExtensionId()),
    extensionRedirectUri: resolveExtensionRedirectUri(),
  },
  mail: {
    provider: process.env.MAIL_PROVIDER || "console",
    fromAddress: process.env.MAIL_FROM_ADDRESS || "noreply@example.com",
    fromName: process.env.MAIL_FROM_NAME || "SourceWeft",
    plunkApiBaseUrl:
      process.env.PLUNK_API_BASE_URL || "https://next-api.useplunk.com",
    plunkApiKey: process.env.PLUNK_API_KEY || "",
  },
  billing: {
    saasEnabled,
    mode: parseBillingMode(process.env.BACKEND_BILLING_MODE, "enforced"),
    scope: parseBillingScope(
      process.env.BACKEND_BILLING_SCOPE,
      "individual_only",
    ),
    creditsEnabled: parseBoolean(process.env.BACKEND_CREDITS_ENABLED, true),
    pagesEnabled: parseBoolean(process.env.BACKEND_PAGES_ENABLED, true),
    provider: effectiveBillingProvider,
    enforceLimits: parseBoolean(
      process.env.BACKEND_BILLING_ENFORCE_LIMITS,
      true,
    ),
    teamBillingEnabled:
      saasEnabled &&
      parseBoolean(process.env.BACKEND_TEAM_BILLING_ENABLED, false),
    creditUnitUsd: parsePositiveNumber(
      process.env.BACKEND_CREDIT_UNIT_USD,
      0.00125,
    ),
    defaultMarkupRate: parseNonNegativeNumber(
      process.env.BACKEND_CREDIT_MARKUP_RATE,
      0.25,
    ),
    defaultPlanFamily: parsePlanFamily(
      process.env.BACKEND_DEFAULT_PLAN_FAMILY,
      "individual_free",
    ),
    defaultMonthlyPages: parseNonNegativeInteger(
      process.env.BACKEND_DEFAULT_MONTHLY_PAGES,
      300,
    ),
    defaultMonthlyCredits: parseNonNegativeInteger(
      process.env.BACKEND_DEFAULT_MONTHLY_CREDITS,
      3000,
    ),
    reconcileEnabled:
      saasEnabled &&
      parseBoolean(process.env.BACKEND_BILLING_RECONCILE_ENABLED, false),
    defaultSuccessUrl: `${resolveWebBaseUrl()}/dashboard/billing?checkout=success`,
    creem: {
      apiKey: process.env.CREEM_API_KEY || "",
      webhookSecret: process.env.CREEM_WEBHOOK_SECRET || "",
      testMode: parseBoolean(process.env.CREEM_TEST_MODE, true),
      individualProMonthlyProductId:
        process.env.CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID || "",
      individualProYearlyProductId:
        process.env.CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID || "",
      teamStandardMonthlyProductId:
        process.env.CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID || "",
      teamStandardYearlyProductId:
        process.env.CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID || "",
      creditTopupProductId: process.env.CREEM_CREDIT_TOPUP_PRODUCT_ID || "",
      pageTopupProductId: process.env.CREEM_PAGE_TOPUP_PRODUCT_ID || "",
    },
    catalog: {
      individualProMonthlyAmountCents: parsePositiveNumber(
        process.env.BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS,
        1200,
      ),
      individualProYearlyAmountCents: parsePositiveNumber(
        process.env.BILLING_PRICE_INDIVIDUAL_PRO_YEARLY_CENTS,
        9600,
      ),
      teamStandardMonthlyAmountCents: parsePositiveNumber(
        process.env.BILLING_PRICE_TEAM_STANDARD_MONTHLY_CENTS,
        4900,
      ),
      teamStandardYearlyAmountCents: parsePositiveNumber(
        process.env.BILLING_PRICE_TEAM_STANDARD_YEARLY_CENTS,
        39200,
      ),
      creditTopupUnitAmount: parsePositiveNumber(
        process.env.BILLING_CREDIT_TOPUP_UNIT_AMOUNT,
        10000,
      ),
      creditTopupAmountCents: parsePositiveNumber(
        process.env.BILLING_CREDIT_TOPUP_AMOUNT_CENTS,
        1250,
      ),
      pageTopupUnitAmount: parsePositiveNumber(
        process.env.BILLING_PAGE_TOPUP_UNIT_AMOUNT,
        1000,
      ),
      pageTopupAmountCents: parsePositiveNumber(
        process.env.BILLING_PAGE_TOPUP_AMOUNT_CENTS,
        500,
      ),
    },
  },
  capability: {
    builtinNamespace:
      process.env.SOURCEWEFT_CAPABILITY_NAMESPACE?.trim() || "sourceweft",
    storagePointerPrefix:
      process.env.SOURCEWEFT_CAPABILITY_STORAGE_POINTER_PREFIX?.trim() ||
      "capability-package:",
  },
  ops: {
    alertsEnabled: parseBoolean(process.env.BACKEND_ALERTS_ENABLED, true),
    alertEmails: parseCsv(process.env.OPS_ALERT_EMAILS),
    alertCooldownMinutes: parsePositiveNumber(
      process.env.OPS_ALERT_COOLDOWN_MINUTES,
      30,
    ),
    alertMinLevel: parseAlertLevel(process.env.OPS_ALERT_MIN_LEVEL, "warn"),
  },
};
