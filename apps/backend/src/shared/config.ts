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

function parseCycleAnchorDay(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.floor(parsed);
  if (rounded < 1 || rounded > 28) {
    return fallback;
  }

  return rounded;
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

export const config = {
  apiPort: Number(process.env.BACKEND_API_PORT || 3001),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@127.0.0.1:5432/sourceweft",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  queueName: process.env.JOB_QUEUE_NAME || "sourceweft-jobs",
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60000),
  schedulerExampleJobEnabled: parseBoolean(
    process.env.BACKEND_SCHEDULER_EXAMPLE_JOB_ENABLED,
    false,
  ),
  litellm: {
    baseUrl: process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000",
    masterKey: process.env.LITELLM_MASTER_KEY || "",
    chatModelAlias: process.env.LITELLM_CHAT_MODEL_ALIAS || "chat-default",
    embedModelAlias: process.env.LITELLM_EMBED_MODEL_ALIAS || "embed-default",
    rerankModelAlias:
      process.env.LITELLM_RERANK_MODEL_ALIAS || "rerank-default",
    timeoutMs: parsePositiveNumber(process.env.LITELLM_TIMEOUT_MS, 30_000),
    maxRetries: parseNonNegativeNumber(process.env.LITELLM_MAX_RETRIES, 2),
  },
  auth: {
    secret: process.env.BETTER_AUTH_SECRET || "replace_with_dev_secret_only",
    baseUrl: process.env.BETTER_AUTH_URL || "http://localhost:3001",
    trustedOrigins: parseCsv(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
    googleClientId: process.env.AUTH_GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET || "",
    githubClientId: process.env.AUTH_GITHUB_CLIENT_ID || "",
    githubClientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET || "",
    oneTapClientId: process.env.AUTH_ONE_TAP_CLIENT_ID || "",
    passkey: {
      rpId: process.env.AUTH_PASSKEY_RP_ID || "localhost",
      rpName: process.env.AUTH_PASSKEY_RP_NAME || "SourceWeft",
      origin: process.env.AUTH_PASSKEY_ORIGIN || "http://localhost:3000",
    },
    extensionClientId:
      process.env.AUTH_EXTENSION_CLIENT_ID || "sourceweft-extension",
    extensionRedirectUri:
      process.env.AUTH_EXTENSION_REDIRECT_URI ||
      "https://<extension-id>.chromiumapp.org/provider_cb",
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
    cycleAnchorDay: parseCycleAnchorDay(
      process.env.BACKEND_BILLING_CYCLE_ANCHOR_DAY,
      1,
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
