import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";
import type { BillingRuntimeConfig } from "./types";
import { parseBooleanEnv as parseBoolean } from "./env";

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

function parseBillingScope(value: string | undefined, fallback: BillingScope) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingScope;
  return billingScopes.has(normalized) ? normalized : fallback;
}

function parsePlanFamily(value: string | undefined, fallback: PlanFamily) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as PlanFamily;
  return planFamilies.has(normalized) ? normalized : fallback;
}

export function readBillingConfig(
  env: Readonly<Record<string, string | undefined>>,
  webBaseUrl: string,
): BillingRuntimeConfig {
  const saasEnabled = parseBoolean(env.SOURCEWEFT_SAAS_ENABLED, false);
  const requestedBillingProvider = parseBillingProvider(
    env.BACKEND_BILLING_PROVIDER,
    "none",
  );
  const effectiveBillingProvider =
    saasEnabled && requestedBillingProvider === "creem" ? "creem" : "none";
  return {
    saasEnabled,
    mode: parseBillingMode(env.BACKEND_BILLING_MODE, "enforced"),
    scope: parseBillingScope(env.BACKEND_BILLING_SCOPE, "individual_only"),
    creditsEnabled: parseBoolean(env.BACKEND_CREDITS_ENABLED, true),
    pagesEnabled: parseBoolean(env.BACKEND_PAGES_ENABLED, true),
    provider: effectiveBillingProvider,
    enforceLimits: parseBoolean(env.BACKEND_BILLING_ENFORCE_LIMITS, true),
    teamBillingEnabled:
      saasEnabled && parseBoolean(env.BACKEND_TEAM_BILLING_ENABLED, false),
    creditUnitUsd: parsePositiveNumber(env.BACKEND_CREDIT_UNIT_USD, 0.00125),
    defaultMarkupRate: parseNonNegativeNumber(
      env.BACKEND_CREDIT_MARKUP_RATE,
      0.25,
    ),
    defaultPlanFamily: parsePlanFamily(
      env.BACKEND_DEFAULT_PLAN_FAMILY,
      "individual_free",
    ),
    defaultMonthlyPages: parseNonNegativeInteger(
      env.BACKEND_DEFAULT_MONTHLY_PAGES,
      300,
    ),
    defaultMonthlyCredits: parseNonNegativeInteger(
      env.BACKEND_DEFAULT_MONTHLY_CREDITS,
      3000,
    ),
    reconcileEnabled:
      saasEnabled && parseBoolean(env.BACKEND_BILLING_RECONCILE_ENABLED, false),
    defaultSuccessUrl: `${webBaseUrl.replace(/\/$/, "")}/dashboard/billing?checkout=success`,
    creem: {
      apiKey: env.CREEM_API_KEY || "",
      webhookSecret: env.CREEM_WEBHOOK_SECRET || "",
      testMode: parseBoolean(env.CREEM_TEST_MODE, true),
      individualProMonthlyProductId:
        env.CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID || "",
      individualProYearlyProductId:
        env.CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID || "",
      teamStandardMonthlyProductId:
        env.CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID || "",
      teamStandardYearlyProductId:
        env.CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID || "",
      creditTopupProductId: env.CREEM_CREDIT_TOPUP_PRODUCT_ID || "",
      pageTopupProductId: env.CREEM_PAGE_TOPUP_PRODUCT_ID || "",
    },
    catalog: {
      individualProMonthlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS,
        1200,
      ),
      individualProYearlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_INDIVIDUAL_PRO_YEARLY_CENTS,
        9600,
      ),
      teamStandardMonthlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_TEAM_STANDARD_MONTHLY_CENTS,
        4900,
      ),
      teamStandardYearlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_TEAM_STANDARD_YEARLY_CENTS,
        39200,
      ),
      creditTopupUnitAmount: parsePositiveNumber(
        env.BILLING_CREDIT_TOPUP_UNIT_AMOUNT,
        10000,
      ),
      creditTopupAmountCents: parsePositiveNumber(
        env.BILLING_CREDIT_TOPUP_AMOUNT_CENTS,
        1250,
      ),
      pageTopupUnitAmount: parsePositiveNumber(
        env.BILLING_PAGE_TOPUP_UNIT_AMOUNT,
        1000,
      ),
      pageTopupAmountCents: parsePositiveNumber(
        env.BILLING_PAGE_TOPUP_AMOUNT_CENTS,
        500,
      ),
    },
  };
}
