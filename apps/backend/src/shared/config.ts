import "dotenv/config";

import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";

type AlertLevel = "warn" | "error" | "critical";

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return fallback;
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

function parseDocumentParseProvider(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return documentParseProviders.has(normalized) ? normalized : fallback;
}

function parseDocumentParseStrategy(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return documentParseStrategies.has(normalized) ? normalized : fallback;
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

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
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

export const config = {
  apiPort: Number(process.env.BACKEND_API_PORT || 3001),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@127.0.0.1:5432/sourceweft",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  queueName: process.env.JOB_QUEUE_NAME || "sourceweft-jobs",
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60000),
  s3: {
    region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET || "",
    endpoint: process.env.S3_ENDPOINT || "",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || "",
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, false),
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
    pureTextBitmapThreshold: parseNonNegativeNumber(
      process.env.DOCUMENT_PARSE_PURE_TEXT_BITMAP_THRESHOLD,
      0.05,
    ),
    pureTextMinCharsPerPage: parseNonNegativeNumber(
      process.env.DOCUMENT_PARSE_PURE_TEXT_MIN_CHARS_PER_PAGE,
      80,
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
  webProviders: {
    anycrawl: {
      apiKey: process.env.ANYCRAWL_API_KEY?.trim() || "",
    },
  },
  schedulerExampleJobEnabled: parseBoolean(
    process.env.BACKEND_SCHEDULER_EXAMPLE_JOB_ENABLED,
    false,
  ),
  modelGatewayEncryptionSecret: requireEnv("MODEL_GATEWAY_ENCRYPTION_SECRET"),
  modelGatewayGlobalConfigPath:
    process.env.MODEL_GATEWAY_GLOBAL_CONFIG_PATH?.trim() || null,
  modelGatewaySyncOpenRouterCatalog: parseBoolean(
    process.env.MODEL_GATEWAY_SYNC_OPENROUTER_CATALOG,
    true,
  ),
  auth: {
    secret: process.env.BETTER_AUTH_SECRET || "replace_with_dev_secret_only",
    baseUrl: resolveApiBaseUrl(),
    errorUrl: resolveAuthErrorUrl(),
    trustedOrigins: resolveTrustedOrigins(),
    googleClientId: process.env.AUTH_GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET || "",
    githubClientId: process.env.AUTH_GITHUB_CLIENT_ID || "",
    githubClientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET || "",
    oneTapClientId: process.env.AUTH_ONE_TAP_CLIENT_ID || "",
    passkey: {
      rpId: process.env.AUTH_PASSKEY_RP_ID || "localhost",
      rpName: process.env.AUTH_PASSKEY_RP_NAME || "SourceWeft",
      origin: resolvePasskeyOrigin(),
    },
    extensionClientId:
      process.env.AUTH_EXTENSION_CLIENT_ID || "sourceweft-extension",
    extensionRedirectUri: resolveExtensionRedirectUri(),
  },
  mail: {
    provider: process.env.MAIL_PROVIDER || "plunk",
    fromAddress: process.env.MAIL_FROM_ADDRESS || "noreply@example.com",
    fromName: process.env.MAIL_FROM_NAME || "SourceWeft",
    plunkApiBaseUrl:
      process.env.PLUNK_API_BASE_URL || "https://next-api.useplunk.com",
    plunkApiKey: process.env.PLUNK_API_KEY || "",
  },
  billing: {
    mode: parseBillingMode(process.env.BACKEND_BILLING_MODE, "shadow"),
    scope: parseBillingScope(
      process.env.BACKEND_BILLING_SCOPE,
      "individual_only",
    ),
    creditsEnabled: parseBoolean(process.env.BACKEND_CREDITS_ENABLED, true),
    pagesEnabled: parseBoolean(process.env.BACKEND_PAGES_ENABLED, true),
    provider: parseBillingProvider(
      process.env.BACKEND_BILLING_PROVIDER,
      "none",
    ),
    enforceLimits: parseBoolean(
      process.env.BACKEND_BILLING_ENFORCE_LIMITS,
      true,
    ),
    teamBillingEnabled: parseBoolean(
      process.env.BACKEND_TEAM_BILLING_ENABLED,
      false,
    ),
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
    reconcileEnabled: parseBoolean(
      process.env.BACKEND_BILLING_RECONCILE_ENABLED,
      true,
    ),
    creem: {
      apiKey: process.env.CREEM_API_KEY || "",
      webhookSecret: process.env.CREEM_WEBHOOK_SECRET || "",
      testMode: parseBoolean(process.env.CREEM_TEST_MODE, true),
      teamStandardProductId: process.env.CREEM_TEAM_STANDARD_PRODUCT_ID || "",
      defaultSuccessUrl:
        process.env.CREEM_DEFAULT_SUCCESS_URL ||
        "http://localhost:3000/app/billing?checkout=success",
    },
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
